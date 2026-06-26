require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { loadBls, saveBls, queryApi } = require('./roller');

const SEND_XML_DIR    = process.env.SEND_XML_DIR || '';
const CHECK_INTERVAL  = 60 * 1000; // 1분

const processedFiles = new Set();

function readFile(filePath) {
  for (const enc of ['utf8', 'cp949', 'latin1']) {
    try { return fs.readFileSync(filePath, enc); } catch { continue; }
  }
  return '';
}

// XML 네임스페이스 제거 (wco:Agent → Agent 등)
function stripNs(xml) {
  return xml
    .replace(/\s+xmlns(?::[a-zA-Z0-9_]+)?="[^"]*"/g, '')
    .replace(/\s+xsi:schemaLocation="[^"]*"/g, '')
    .replace(/<(\/?)[a-zA-Z0-9_]+:([a-zA-Z0-9_])/g, '<$1$2');
}

function extractInfo(xml) {
  const clean = stripNs(xml);

  // 대행사 코드: GoodsShipment > Agent > ID
  const agentM = clean.match(/<GoodsShipment[^>]*>[\s\S]*?<Agent>\s*<ID>([^<]{1,20})<\/ID>/);
  const agencyCode = agentM ? agentM[1].trim() : null;

  // HBL: Consignment > TransportContractDocument > TypeCode=714
  const hblM = clean.match(/<TransportContractDocument>\s*<ID>([^<]+)<\/ID>\s*<TypeCode>714<\/TypeCode>/s);
  const hblNo = hblM ? hblM[1].trim() : null;

  // 연도: IssueDateTime 앞 4자리
  const yrM = clean.match(/<IssueDateTime>(\d{4})/);
  const blYy = yrM ? yrM[1] : String(new Date().getFullYear());

  return { agencyCode, hblNo, blYy };
}

async function processFile(filePath) {
  const content = readFile(filePath);
  if (!content) return;

  const { agencyCode, hblNo, blYy } = extractInfo(content);
  if (!agencyCode || !hblNo) return;

  const bls = loadBls();
  if (bls.find(b => b.hblNo === hblNo && b.blYy === blYy)) return; // 이미 등록됨

  console.log(`[XML감시] 신규 HBL: ${hblNo} (${blYy}) 대행사: ${agencyCode}`);

  const result = await queryApi(hblNo, blYy);
  const now = new Date().toISOString();
  const newBl = {
    hblNo,
    blYy,
    agencyCode,
    registeredAt: now,
    currentStatus: result?.mtTrgtCargYnNm || '-',
    prgsStts:      result?.prgsStts        || '-',
    shipNm:        result?.shipNm          || '-',
    dsprNm:        result?.dsprNm          || '-',
    etprDt:        result?.etprDt          || '-',
    mblNo:         result?.mblNo           || '-',
    lastChecked:   now,
    scanStatus:    result ? 'ok' : 'error',
    hasChange:     false,
    progressHistory: [],
  };

  if (result?.mtTrgtCargYnNm && result.mtTrgtCargYnNm !== '-' && result.mtTrgtCargYnNm !== '비대상') {
    newBl.progressHistory.push({ status: result.mtTrgtCargYnNm, detectedAt: now });
  }

  bls.push(newBl);
  saveBls(bls);
  console.log(`[XML감시] 등록 완료: ${hblNo}`);
}

function scan() {
  if (!SEND_XML_DIR) return;
  if (!fs.existsSync(SEND_XML_DIR)) {
    console.warn(`[XML감시] 폴더 접근 불가: ${SEND_XML_DIR}`);
    return;
  }
  try {
    const files = fs.readdirSync(SEND_XML_DIR)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .map(f => path.join(SEND_XML_DIR, f));

    for (const file of files) {
      if (processedFiles.has(file)) continue;
      processedFiles.add(file);
      processFile(file).catch(e => console.error(`[XML감시] 처리 오류 (${path.basename(file)}): ${e.message}`));
    }
  } catch (e) {
    console.error(`[XML감시] 스캔 오류: ${e.message}`);
  }
}

function startWatcher() {
  if (!SEND_XML_DIR) {
    console.log('[XML감시] SEND_XML_DIR 미설정 — 자동 HBL 등록 비활성화');
    return;
  }
  console.log(`[XML감시] 시작: ${SEND_XML_DIR} (1분 간격)`);
  scan();
  setInterval(scan, CHECK_INTERVAL);
}

module.exports = { startWatcher };
