const { Watchlist, CaseHistory, CaseStatistics, Device } = require('../models');
const { sendCaseAlert } = require('./fcmService');
const logger = require('../config/logger');

const IN_SESSION_REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// -------------------- Helpers --------------------

function parseCaseIdentifier(caseIdentifier) {
  const courtMatch = caseIdentifier.match(/^COURT:(\d+):(.+)$/i);

  if (courtMatch) {
    const courtNumber = courtMatch[1];
    const remainder = courtMatch[2];

    if (/^\d+$/.test(remainder)) {
      return { type: 'position', courtNumber, position: parseInt(remainder) };
    }

    return { type: 'caseNumber', courtNumber, caseNumber: remainder };
  }

  return { type: 'caseNumber', caseNumber: caseIdentifier };
}

function findCaseInCourts(courts, identifier) {
  const parsed = parseCaseIdentifier(identifier);

  if (parsed.type === 'position') {
    return courts.find(
      c => c.courtNumber === parsed.courtNumber && c.queuePosition === parsed.position
    );
  }

  if (parsed.courtNumber) {
    return courts.find(
      c => c.courtNumber === parsed.courtNumber && c.caseNumber === parsed.caseNumber
    );
  }

  return courts.find(c => c.caseNumber === parsed.caseNumber);
}

// -------------------- Main Flow --------------------

async function processCaseUpdates(courtData) {
  try {
    const { courts, scrapedAt } = courtData;
    const watchlists = await Watchlist.find({ isActive: true });

    if (!watchlists.length) return;

    const courtsByCourt = {};
    courts.forEach(c => {
      if (!courtsByCourt[c.courtNumber]) courtsByCourt[c.courtNumber] = [];
      courtsByCourt[c.courtNumber].push(c);
    });

    for (const watch of watchlists) {
      try {
        await processWatchlistItem(watch, courts, courtsByCourt, scrapedAt);
      } catch (e) {
        logger.error(`Watchlist ${watch._id} failed`, e);
      }
    }

    await saveCaseHistory(courts, scrapedAt);
    await updateCaseStatistics(courts);

  } catch (e) {
    logger.error('processCaseUpdates error', e);
  }
}

async function processWatchlistItem(watch, courts, courtsByCourt) {
  const { deviceId, caseNumber, notificationSettings } = watch;

  const courtWithCase = findCaseInCourts(courts, caseNumber);

  // ---------- COMPLETED ----------
  if (!courtWithCase) {
    if (['in_session', 'approaching'].includes(watch.lastNotificationSent)) {
      const device = await Device.findOne({ deviceId, isActive: true });
      if (device?.fcmToken && notificationSettings.completed) {
        await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'completed', {});
        watch.lastNotificationSent = 'completed';
        watch.lastNotificationTime = new Date();
        await watch.save();
      }
    }
    return;
  }

  const device = await Device.findOne({ deviceId, isActive: true });
  if (!device?.fcmToken) return;

  // ---------- IN_SESSION (initial + periodic) ----------
  if (courtWithCase.caseStatus === 'IN_SESSION') {
    if (!notificationSettings.inSession) return;

    const now = Date.now();
    const lastTime = watch.lastNotificationTime
      ? new Date(watch.lastNotificationTime).getTime()
      : 0;

    const shouldSend =
      watch.lastNotificationSent !== 'in_session' ||
      now - lastTime >= IN_SESSION_REPEAT_INTERVAL_MS;

    if (shouldSend) {
      await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'in_session', {
        courtNumber: courtWithCase.courtNumber,
        judgeName: courtWithCase.judgeName,
        streamUrl: courtWithCase.streamUrl,
        benchType: courtWithCase.benchType,
        gsrno: courtWithCase.gsrno,
        actualCaseNumber: courtWithCase.caseNumber
      });

      watch.lastNotificationSent = 'in_session';
      watch.lastNotificationTime = new Date();
      await watch.save();
    }

    return; // stop here
  }

  // ---------- QUEUE LOGIC ----------
  if (!courtWithCase.queuePosition) return;

  const sameCourt = courtsByCourt[courtWithCase.courtNumber] || [];
  const position = calculateQueuePosition(
    courtWithCase.caseNumber,
    courtWithCase,
    sameCourt
  );

  if (position == null) return;

  const earlyThreshold = parseInt(process.env.NOTIFICATION_EARLY_WARNING_COUNT || 5);

  // ---------- EARLY WARNING ----------
  if (
    position <= earlyThreshold &&
    position > 1 &&
    notificationSettings.earlyWarning &&
    ['none', 'completed'].includes(watch.lastNotificationSent)
  ) {
    await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'early_warning', {
      courtNumber: courtWithCase.courtNumber,
      position,
      judgeName: courtWithCase.judgeName,
      gsrno: courtWithCase.gsrno,
      actualCaseNumber: courtWithCase.caseNumber
    });

    watch.lastNotificationSent = 'early_warning';
    watch.lastNotificationTime = new Date();
    await watch.save();
  }

  // ---------- APPROACHING ----------
  if (
    position === 1 &&
    notificationSettings.approaching &&
    !['approaching', 'in_session'].includes(watch.lastNotificationSent)
  ) {
    await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'approaching', {
      courtNumber: courtWithCase.courtNumber,
      judgeName: courtWithCase.judgeName,
      gsrno: courtWithCase.gsrno,
      currentCase: getCurrentCase(sameCourt),
      actualCaseNumber: courtWithCase.caseNumber
    });

    watch.lastNotificationSent = 'approaching';
    watch.lastNotificationTime = new Date();
    await watch.save();
  }
}

// -------------------- Queue helpers --------------------

function calculateQueuePosition(_, courtWithCase, sameCourt) {
  if (courtWithCase.queuePosition != null) {
    const ahead = sameCourt.filter(
      c =>
        c.queuePosition != null &&
        c.queuePosition < courtWithCase.queuePosition &&
        !['IN_SESSION', 'SITTING_OVER'].includes(c.caseStatus)
    ).length;
    return ahead + 1;
  }

  const pending = sameCourt.filter(
    c => !['IN_SESSION', 'SITTING_OVER'].includes(c.caseStatus)
  );

  const idx = pending.findIndex(c => c.caseNumber === courtWithCase.caseNumber);
  return idx === -1 ? null : idx + 1;
}

function getCurrentCase(sameCourt) {
  const live = sameCourt.find(c => c.caseStatus === 'IN_SESSION');
  return live ? live.caseNumber : null;
}

// -------------------- History / Stats --------------------

async function saveCaseHistory(courts, scrapedAt) {
  const entries = courts
    .filter(c => c.caseNumber)
    .map(c => ({
      caseNumber: c.caseNumber,
      courthouse: 'Gujarat High Court',
      courtNumber: c.courtNumber,
      judgeName: c.judgeName,
      benchType: c.benchType,
      status: c.caseStatus,
      position: c.queuePosition,
      gsrno: c.gsrno,
      streamUrl: c.streamUrl,
      scrapedAt: new Date(scrapedAt)
    }));

  if (!entries.length) return;

  await CaseHistory.insertMany(entries, { ordered: false }).catch(e => {
    if (e.code !== 11000) throw e;
  });
}

async function updateCaseStatistics(courts) {
  for (const c of courts) {
    if (!c.caseNumber) continue;

    const watchCount = await Watchlist.countDocuments({
      caseNumber: c.caseNumber,
      isActive: true
    });

    await CaseStatistics.findOneAndUpdate(
      { caseNumber: c.caseNumber },
      {
        $set: { lastSeen: new Date(), watchCount },
        $addToSet: { courts: c.courtNumber, judges: c.judgeName },
        $push: {
          statusHistory: {
            status: c.caseStatus,
            timestamp: new Date(),
            courtNumber: c.courtNumber,
            queuePosition: c.queuePosition
          }
        },
        $inc: { totalAppearances: 1 }
      },
      { upsert: true }
    );
  }
}

// -------------------- Exports --------------------

module.exports = {
  processCaseUpdates,
  parseCaseIdentifier,
  findCaseInCourts
};
