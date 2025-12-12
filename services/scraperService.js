const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../config/logger');

const BASE = process.env.COURT_BASE_URL || 'https://gujarathighcourt.nic.in/streamingboard/';
const XHR_URL = process.env.COURT_XHR_URL || `${BASE}indexrequest.php`;

const cleanText = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';
const isValidValue = (val) => val && val !== '-' && val.trim() !== '';

async function scrapeCourtData() {
  try {
    const [xhrResp, pageResp] = await Promise.all([
      axios.get(XHR_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json, text/javascript, */*; q=0.01'
        },
        timeout: 15000
      }),
      axios.get(BASE, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 15000
      })
    ]);

    const xhrData = Array.isArray(xhrResp.data) ? xhrResp.data : JSON.parse(xhrResp.data || '[]');
    const $ = cheerio.load(pageResp.data || '');

    const courts = [];
    const scrapedAt = new Date().toISOString();

    for (const row of xhrData) {
      const courtCode = String(row.courtcode || '').trim();
      if (!courtCode) continue;

      const cardSelector = `#dv_${courtCode}`;
      const $card = $(cardSelector);

      let judgeName = '';
      const catB = $card.find('.card-category b').first();
      if (catB && catB.length) judgeName = cleanText(catB.text());
      if (!judgeName) {
        judgeName = cleanText($card.find('.card-header, .card-title, .card-body').first().text());
      }
      judgeName = judgeName.replace('[Live]', '').trim();

      const a = $card.find('a').first();
      let streamUrl = a && a.attr('href') ? a.attr('href').trim() : null;
      if (streamUrl && streamUrl.startsWith('/')) {
        streamUrl = `https://gujarathighcourt.nic.in${streamUrl}`;
      }

      const judgePhotos = [];
      $card.find('.photoclass, img').each((i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (src) {
          const absolute = src.startsWith('http') ? src : `https://gujarathighcourt.nic.in/streamingboard/${src.replace(/^\.\//, '')}`;
          judgePhotos.push(absolute);
        }
      });

      const judgeCount = judgePhotos.length;
      const benchType = judgeCount >= 2 ? 'Division Bench' : 'Single Bench';

      let courtNumber = '';
      const courtElById = $card.find(`#court_${courtCode}`);
      if (courtElById && courtElById.length) {
        courtNumber = cleanText(courtElById.text()).replace(/COURT\s*NO:?/i, '').trim();
      } else {
        const possible = $card.find('*').toArray().find(el => /COURT\s*NO[:\s]/i.test($(el).text() || ''));
        if (possible) courtNumber = cleanText($(possible).text()).replace(/COURT\s*NO:?/i, '').trim();
      }

      // Get gsrno from XHR data (this is the queue position!)
      let srNo = cleanText(row.gsrno || '');
      if (!srNo || srNo === '-') {
        // Fallback to scraping from page
        const srEl = $card.find(`#srno_${courtCode}`);
        if (srEl && srEl.length) srNo = cleanText(srEl.text());
      }

      const caseList = cleanText(row.causelisttype || '');
      const caseFooterText = cleanText(row.caseinfo || '');

      let caseNumber = null;
      let caseStatus = null;
      let caseType = null;
      if (caseFooterText) {
        if (/COURT\s*SITTING\s*OVER/i.test(caseFooterText)) {
          caseStatus = 'SITTING_OVER';
          caseType = 'sitting_over';
        } else if (caseFooterText.includes('(RECESS)')) {
          caseStatus = 'RECESS';
          caseType = 'recess';
          caseNumber = caseFooterText.replace('(RECESS)', '').trim();
        } else if (isValidValue(caseFooterText)) {
          caseStatus = 'IN_SESSION';
          caseType = 'active';
          caseNumber = caseFooterText;
        }
      }

      let pageNumber = 1;
      const pageClass = $card.attr('class') || '';
      const pageMatch = pageClass.match(/page_(\d+)/);
      if (pageMatch) pageNumber = parseInt(pageMatch[1], 10);

      const isLive = $card.find('.blink_me').length > 0;

      // Parse queue position from srNo
      let queuePosition = null;
      if (srNo && srNo !== '-') {
        // Try to extract number from srNo (e.g., "106" -> 106)
        const posMatch = srNo.match(/(\d+)/);
        if (posMatch) {
          queuePosition = parseInt(posMatch[1], 10);
        }
      }

      courts.push({
        id: courtCode,
        judgeName,
        judgeCount,
        benchType,
        isLive,
        courtNumber,
        courtNumberShort: courtNumber,
        srNo: srNo || null,
        gsrno: srNo || null, // Keep both for compatibility
        queuePosition: queuePosition, // Parsed numeric position
        caseList: caseList || null,
        caseNumber,
        caseStatus,
        caseType,
        streamUrl,
        judgePhotos,
        hasStream: !!streamUrl,
        isActive: isLive || caseStatus === 'IN_SESSION' || caseStatus === 'RECESS',
        pageNumber,
        scrapedAt
      });
    }

    courts.sort((a, b) => {
      const numA = parseInt(a.courtNumberShort) || 9999;
      const numB = parseInt(b.courtNumberShort) || 9999;
      return numA - numB;
    });

    const stats = {
      total: courts.length,
      live: courts.filter(c => c.isLive).length,
      active: courts.filter(c => c.isActive).length,
      recess: courts.filter(c => c.caseStatus === 'RECESS').length,
      sittingOver: courts.filter(c => c.caseStatus === 'SITTING_OVER').length,
      inSession: courts.filter(c => c.caseStatus === 'IN_SESSION').length,
      withStream: courts.filter(c => c.hasStream).length,
      divisionBench: courts.filter(c => c.benchType === 'Division Bench').length,
      singleBench: courts.filter(c => c.benchType === 'Single Bench').length,
      withCaseNumber: courts.filter(c => c.caseNumber).length,
      withSerialNumber: courts.filter(c => c.srNo).length,
      withQueuePosition: courts.filter(c => c.queuePosition).length
    };

    const byListType = {};
    courts.forEach(c => {
      const listType = c.caseList || 'No List';
      if (!byListType[listType]) byListType[listType] = [];
      byListType[listType].push(c);
    });

    logger.info(`Scraped ${courts.length} courts successfully (${stats.withQueuePosition} with queue positions)`);

    return {
      success: true,
      scrapedAt,
      currentDate: $('#currdate').val() || null,
      summary: stats,
      groupedByListType: byListType,
      courts
    };

  } catch (err) {
    logger.error('Scraping error:', err.message);
    throw err;
  }
}

module.exports = {
  scrapeCourtData
};