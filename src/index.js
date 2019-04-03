const {
  BaseKonnector,
  scrape,
  saveBills,
  log,
  saveFiles
} = require('cozy-konnector-libs')

module.exports = new BaseKonnector(start)

const cheerio = require('cheerio')
var rp = require('request-promise')
var cookiejar = rp.jar()
var moment = require('moment')

const baseURL = 'https://mon-espace.ekwateur.fr'
const loginURL = baseURL + '/se_connecter'
const postLoginURL = baseURL + '/login_check'
const billsURL = baseURL + '/mes_factures_et_acomptes'

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const html = await getDocuments()

  log('info', 'Parsing list of documents')
  const $ = cheerio.load(html)

  const docs = parseDocuments($)

  downloadProofOfResidence($)
  await saveBills(docs, fields, {
    identifiers: ['']
  })
}

// Get the sample page and parse the cookie
async function authenticate(username, password) {
  const options = {
    uri: loginURL,
    jar: cookiejar
  }

  const loginFormData = {
    _username: username,
    _password: password,
    _mode: 'cXI4cE93PT0' // Why ? I don't know
  }

  return rp(options)
    .then(async function(html) {
      // Get the csrf token
      let $ = cheerio.load(html)
      let csrf_token = $('input[name=_csrf_token]').attr('value')

      loginFormData['_csrf_token'] = csrf_token

      const optionsLogin = {
        method: 'POST',
        uri: postLoginURL,
        jar: cookiejar,
        form: loginFormData,
        followAllRedirects: true
      }

      // Change the options, but keep the cookiejar
      await rp(optionsLogin)
        .then(function(htmlString) {
          let $ = cheerio.load(htmlString)
          if ($('.menu__user').length === 0) {
            throw new Error('LOGIN_FAILED')
          }
        })
        .catch(function(err) {
          log('error', err.message)
          throw new Error('UNKNOWN_ERROR')
        })
    })
    .catch(function(err) {
      log('error', err.message)
      log('error', 'Failed')
    })
}

async function getDocuments() {
  // Must do this request to get the bill page
  const tmpopts = {
    uri: baseURL,
    jar: cookiejar
  }

  const billsOpts = {
    uri: billsURL,
    jar: cookiejar
  }
  return rp(tmpopts)
    .then(() =>
      rp(billsOpts)
        .then(html => html)
        .catch(function(err) {
          log('error', err.message)
          throw new Error('UNKNOWN_ERROR')
        })
    )
    .catch(function(err) {
      log('error', err.message)
      throw new Error('UNKNOWN_ERROR')
    })
}

function cleanURL(url) {
  if (url === undefined) {
    return ''
  }
  return baseURL + url.trim()
}

async function downloadProofOfResidence() {
  const files = [
    {
      filename: 'Justificatif de domicile.pdf',
      fileurl: baseURL + '/client/justificatif_de_domicile',
      requestOptions: {
        method: 'GET',
        jar: cookiejar
      }
    }
  ]
  return saveFiles(files, '/')
}

function parseDocuments($) {
  const items = scrape(
    $,
    {
      fileurl: {
        sel: 'td[class="table__body__file"] > a',
        attr: 'href',
        parse: cleanURL
      },
      date: {
        sel: 'td:first-child'
      },
      amount: {
        sel: 'td[class="table__body__price"]',
        parse: val => parseFloat(val.slice(0, -1).replace(',', '.'))
      },
      type: {
        sel: 'td:nth-child(3)'
      }
    },
    'tr[class="table__body__line table__body__line--payed"]'
  )

  var returnedItems = items.filter(val => val.date !== '')
  returnedItems = returnedItems.filter(val => val.fileurl !== '')

  returnedItems.forEach(function(item) {
    item.id = item.fileurl.split('/').pop()
    item.date = moment(item.date, 'DD/MM/YYYY').toDate()
    item.filename =
      [
        moment().format('YYYY-MM-DD', item.date),
        'ekWateur',
        item.amount + '€',
        item.id
      ].join('_') + '.pdf'
  })

  return returnedItems.map(doc => ({
    ...doc,
    currency: '€',
    vendor: 'ekWateur',
    requestOptions: {
      method: 'GET',
      jar: cookiejar
    },
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}
