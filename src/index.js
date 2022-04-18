process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://6cc8166d546d4ae59d29c43dd058b33c@errors.cozycloud.cc/12'

const {
  BaseKonnector,
  scrape,
  saveBills,
  log,
  saveFiles,
  cozyClient,
  utils,
  errors
} = require('cozy-konnector-libs')

module.exports = new BaseKonnector(start)

// Importing models to get qualification by label
const models = cozyClient.new.models
const { Qualification } = models.document

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
  await saveBills(docs, fields, {
    identifiers: ['ekwateur'],
    fileIdAttributes: ['vendorRef']
  })
  await downloadProofOfResidence(fields)
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

  const html = await rp(options)
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
  try {
    await rp(optionsLogin)
  } catch (e) {
    if (e.statusCode === 500) {
      log('error', 'Error 500 on login, sign of bad credentials')
      throw new Error(errors.LOGIN_FAILED)
    } else {
      throw e
    }
  }
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

async function downloadProofOfResidence(fields) {
  const files = [
    {
      shouldReplaceFile: true,
      filename: 'attestation de contrat (justificatif de domicile).pdf',
      fileurl: baseURL + '/client/justificatif_de_domicile',
      requestOptions: {
        method: 'GET',
        jar: cookiejar
      },
      fileAttributes: {
        metadata: {
          contentAuthor: 'ekwateur.fr',
          isSubscription: true,
          carbonCopy: true
        }
      }
    }
  ]
  return saveFiles(files, fields)
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
        parse: val => parseFloat(val.slice(0, -1).replaceAll(' ' ,'').replace(',', '.'))
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
    // type attribut not relevant as a bill type, but can be set as subtype for futur use
    item.subtype = item.type
    delete item.type
    item.vendorRef = item.fileurl.split('/').pop()
    item.date = moment(item.date, 'DD/MM/YYYY').toDate()
    item.filename =
      [
        moment(item.date).format('YYYY-MM-DD'),
        'ekWateur',
        item.amount + '€',
        item.subtype
      ].join('_') + '.pdf'
  })

  return returnedItems.map(doc => ({
    ...doc,
    currency: '€',
    vendor: 'ekwateur',
    requestOptions: {
      method: 'GET',
      jar: cookiejar
    },
    fileAttributes: {
      metadata: {
        contentAuthor: 'ekwateur.fr',
        issueDate: utils.formatDate(doc.date),
        datetime: utils.formatDate(doc.date),
        datetimeLabel: `issueDate`,
        invoiceNumber: `${doc.vendorRef}`,
        isSubscription: true,
        carbonCopy: true,
        qualification: Qualification.getByLabel('energy_invoice')
      }
    }
  }))
}
