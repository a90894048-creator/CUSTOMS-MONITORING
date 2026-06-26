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

  // 신고일자: IssueDateTime YYYYMMDD
  const dtM = clean.match(/<IssueDateTime>(\d{4})(\d{2})(\d{2})/);
  const blDate = dtM ? `${dtM[1]}-${dtM[2]}-${dtM[3]}` : null;
  const blYy = dtM ? dtM[1] : String(new Date().getFullYear());

  return { agencyCode, hblNo, blYy, blDate };
}

async function processFile(filePath) {
  const content = readFile(filePath);
  if (!content) return;

  const { agencyCode, hblNo, blYy, blDate } = extractInfo(content);
  if (!agencyCode || !hblNo) return;

  const bls = loadBls();
  if (bls.find(b => b.hblNo === hblNo && b.blYy === blYy)) return; // 이미 등록됨

  console.log(`[XML감시] 신규 HBL: ${hblNo} (${blDate || blYy}) 대행사: ${agencyCode}`);

  const result = await queryApi(hblNo, blYy);
  const now = new Date().toISOString();
  const newBl = {
    hblNo, blYy, agencyCode,
    blDate:        blDate || null,
    registeredAt:  now,
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

// 날짜 범위 + 대행사 코드로 XML 폴더 일괄 스캔
async function scanForAgency(agencyCode, fromDate, toDate) {
  if (!SEND_XML_DIR) return { registered: 0, total: 0, error: 'not_configured' };
  if (!fs.existsSync(SEND_XML_DIR)) {
    console.warn(`[XML스캔] 폴더 접근 불가: ${SEND_XML_DIR}`);
    return { registered: 0, total: 0, error: 'folder_not_accessible' };
  }

  let total = 0, registered = 0;
  try {
    const files = fs.readdirSync(SEND_XML_DIR)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .map(f => path.join(SEND_XML_DIR, f));

    for (const file of files) {
      const content = readFile(file);
      if (!content) continue;

      const { agencyCode: fileAgency, hblNo, blYy, blDate } = extractInfo(content);
      if (!fileAgency || fileAgency !== agencyCode || !hblNo) continue;

      // 날짜 필터
      if (fromDate && blDate && blDate < fromDate) continue;
      if (toDate   && blDate && blDate > toDate)   continue;

      total++;

      const current = loadBls();
      if (current.find(b => b.hblNo === hblNo && b.blYy === blYy)) continue; // 이미 등록

      const result = await queryApi(hblNo, blYy);
      const now = new Date().toISOString();
      const newBl = {
        hblNo, blYy, agencyCode,
        blDate:        blDate || null,
        registeredAt:  now,
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

      const fresh = loadBls();
      if (!fresh.find(b => b.hblNo === hblNo && b.blYy === blYy)) {
        fresh.push(newBl);
        saveBls(fresh);
        registered++;
        console.log(`[XML스캔] 등록: ${hblNo} (${blDate})`);
      }
    }
  } catch (e) {
    console.error(`[XML스캔] 오류: ${e.message}`);
    return { registered, total, error: e.message };
  }

  console.log(`[XML스캔] 완료 — 스캔: ${total}, 신규등록: ${registered}`);
  return { registered, total };
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

module.exports = { startWatcher, scanForAgency };
