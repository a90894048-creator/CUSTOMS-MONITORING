const https = require('https');
const xml2js = require('xml2js');

const API_KEY = 'n240w235n190z202f080q050e0';
const BL = process.argv[2] || 'HGS26060769';
const YEAR = process.argv[3] || '2026';

const params = new URLSearchParams({ crkyCn: API_KEY, mblNo: BL, blYy: YEAR });
const url = `https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo?${params}`;

console.log('조회 BL:', BL, '/ 년도:', YEAR);
console.log('URL:', url.replace(API_KEY, '***'));

const req = https.get(url, { rejectUnauthorized: false }, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', async () => {
    console.log('\n[STATUS]', res.statusCode);
    try {
      const parsed = await xml2js.parseStringPromise(data, { explicitArray: false });
      console.log('\n[PARSED JSON]\n', JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log('\n[RAW XML]\n', data);
    }
  });
});

req.on('error', e => console.error('ERR:', e.message));
req.setTimeout(15000, () => { console.error('TIMEOUT'); req.destroy(); });
