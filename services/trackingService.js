const { Watchlist, CaseHistory, CaseStatistics, Device } = require('../models');
const { sendCaseAlert } = require('./fcmService');
const logger = require('../config/logger');

// Parse case number to extract court and position if in format COURT:1:7
function parseCaseIdentifier(caseIdentifier) {
  // Check if it's in format COURT:courtNumber:position or COURT:courtNumber:caseNumber
  const courtMatch = caseIdentifier.match(/^COURT:(\d+):(.+)$/i);
  
  if (courtMatch) {
    const courtNumber = courtMatch[1];
    const remainder = courtMatch[2];
    
    // Check if remainder is a number (position) or case number
    if (/^\d+$/.test(remainder)) {
      return {
        type: 'position',
        courtNumber: courtNumber,
        position: parseInt(remainder),
        original: caseIdentifier
      };
    } else {
      return {
        type: 'caseNumber',
        courtNumber: courtNumber,
        caseNumber: remainder,
        original: caseIdentifier
      };
    }
  }
  
  // Regular case number
  return {
    type: 'caseNumber',
    caseNumber: caseIdentifier,
    original: caseIdentifier
  };
}

// Find case in courts array based on identifier
function findCaseInCourts(courts, identifier) {
  const parsed = parseCaseIdentifier(identifier);
  
  if (parsed.type === 'position') {
    // Find by court number and queue position
    return courts.find(c => 
      c.courtNumber === parsed.courtNumber && 
      c.queuePosition === parsed.position
    );
  } else if (parsed.type === 'caseNumber' && parsed.courtNumber) {
    // Find by court number and case number (strip COURT: prefix)
    return courts.find(c => 
      c.courtNumber === parsed.courtNumber && 
      c.caseNumber === parsed.caseNumber
    );
  } else {
    // Find by case number only
    return courts.find(c => c.caseNumber === parsed.caseNumber);
  }
}

// Track case status changes and send notifications
async function processCaseUpdates(courtData) {
  try {
    const { courts, scrapedAt } = courtData;
    
    // Get all active watchlists
    const watchlists = await Watchlist.find({ isActive: true });
    
    if (watchlists.length === 0) {
      logger.info('No active watchlists to process');
      return;
    }

    logger.info(`Processing ${watchlists.length} active watchlists`);

    // Group courts by court number for better tracking
    const courtsByCourt = {};
    courts.forEach(court => {
      if (!courtsByCourt[court.courtNumber]) {
        courtsByCourt[court.courtNumber] = [];
      }
      courtsByCourt[court.courtNumber].push(court);
    });

    // Process each watchlist
    for (const watch of watchlists) {
      try {
        await processWatchlistItem(watch, courts, courtsByCourt, scrapedAt);
      } catch (error) {
        logger.error(`Error processing watchlist ${watch._id}:`, error);
      }
    }

    // Save case history
    await saveCaseHistory(courts, scrapedAt);

    // Update case statistics
    await updateCaseStatistics(courts);

  } catch (error) {
    logger.error('Error in processCaseUpdates:', error);
  }
}

// Process individual watchlist item
async function processWatchlistItem(watch, courts, courtsByCourt, scrapedAt) {
  const { deviceId, caseNumber, notificationSettings, lastNotificationSent } = watch;

  logger.info(`Processing watchlist for case: ${caseNumber}`);

  // Find if case is currently in any court (supports multiple formats)
  const courtWithCase = findCaseInCourts(courts, caseNumber);

  if (!courtWithCase) {
    logger.info(`Case ${caseNumber} not found in current court data`);
    
    // Check if this was previously in session - send completed notification
    if (lastNotificationSent === 'in_session' || lastNotificationSent === 'approaching') {
      const device = await Device.findOne({ deviceId, isActive: true });
      if (device && device.fcmToken && notificationSettings.completed) {
        await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'completed', {
          courtNumber: '-',
          judgeName: ''
        });

        watch.lastNotificationSent = 'completed';
        watch.lastNotificationTime = new Date();
        await watch.save();
        logger.info(`Sent COMPLETED alert for case ${caseNumber} to device ${deviceId}`);
      }
    }
    return;
  }

  logger.info(`Found case ${caseNumber} in court ${courtWithCase.courtNumber}, status: ${courtWithCase.caseStatus}, position: ${courtWithCase.queuePosition}`);

  // Get device FCM token
  const device = await Device.findOne({ deviceId, isActive: true });
  if (!device || !device.fcmToken) {
    logger.warn(`Device ${deviceId} not found or no FCM token`);
    return;
  }

  // Case is currently in session
  if (courtWithCase.caseStatus === 'IN_SESSION') {
    if (notificationSettings.inSession && lastNotificationSent !== 'in_session') {
      await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'in_session', {
        courtNumber: courtWithCase.courtNumber,
        judgeName: courtWithCase.judgeName,
        streamUrl: courtWithCase.streamUrl,
        benchType: courtWithCase.benchType,
        gsrno: courtWithCase.gsrno,
        actualCaseNumber: courtWithCase.caseNumber // Include actual case number
      });

      watch.lastNotificationSent = 'in_session';
      watch.lastNotificationTime = new Date();
      await watch.save();
      logger.info(`Sent IN_SESSION alert for case ${caseNumber} to device ${deviceId}`);
    }
  }
  // Check for approaching/early warning based on queue position
  else if (courtWithCase.queuePosition) {
    // Get all cases in the same court to determine queue
    const sameCourt = courtsByCourt[courtWithCase.courtNumber] || [];
    
    // Calculate position in queue
    const position = calculateQueuePosition(courtWithCase.caseNumber, courtWithCase, sameCourt);
    
    if (position !== null) {
      const earlyWarningThreshold = parseInt(process.env.NOTIFICATION_EARLY_WARNING_COUNT || 5);
      
      // Early warning: Case is N positions away
      if (position <= earlyWarningThreshold && position > 1) {
        if (notificationSettings.earlyWarning && 
            (lastNotificationSent === 'none' || lastNotificationSent === 'completed')) {
          await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'early_warning', {
            courtNumber: courtWithCase.courtNumber,
            position: position,
            judgeName: courtWithCase.judgeName,
            gsrno: courtWithCase.gsrno,
            totalCases: sameCourt.filter(c => c.queuePosition).length,
            actualCaseNumber: courtWithCase.caseNumber
          });

          watch.lastNotificationSent = 'early_warning';
          watch.lastNotificationTime = new Date();
          await watch.save();
          logger.info(`Sent EARLY_WARNING alert for case ${caseNumber} (position: ${position})`);
        }
      }
      
      // Approaching: Case is next in line
      if (position === 1) {
        if (notificationSettings.approaching && 
            lastNotificationSent !== 'approaching' && 
            lastNotificationSent !== 'in_session') {
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
          logger.info(`Sent APPROACHING alert for case ${caseNumber}`);
        }
      }
    }
  }
}

// Calculate queue position for a case
function calculateQueuePosition(caseNumber, courtWithCase, sameCourt) {
  // If court has queuePosition (parsed from gsrno)
  if (courtWithCase.queuePosition !== null) {
    // Count how many cases have lower queue positions
    const casesAhead = sameCourt.filter(c => 
      c.queuePosition !== null && 
      c.queuePosition < courtWithCase.queuePosition &&
      c.caseStatus !== 'IN_SESSION' &&
      c.caseStatus !== 'SITTING_OVER'
    ).length;
    
    return casesAhead + 1; // +1 because position starts at 1
  }
  
  // Fallback: Use array order if no queue position
  const caseIndex = sameCourt.findIndex(c => c.caseNumber === caseNumber);
  if (caseIndex === -1) return null;
  
  // Filter only pending cases
  const pendingCases = sameCourt.filter(c => 
    c.caseStatus !== 'IN_SESSION' && 
    c.caseStatus !== 'SITTING_OVER'
  );
  
  const pendingIndex = pendingCases.findIndex(c => c.caseNumber === caseNumber);
  return pendingIndex !== -1 ? pendingIndex + 1 : null;
}

// Get currently active case in court
function getCurrentCase(sameCourt) {
  const inSession = sameCourt.find(c => c.caseStatus === 'IN_SESSION');
  return inSession ? inSession.caseNumber : null;
}

// Save case history
async function saveCaseHistory(courts, scrapedAt) {
  try {
    const historyEntries = [];

    for (const court of courts) {
      if (court.caseNumber) {
        historyEntries.push({
          caseNumber: court.caseNumber,
          courthouse: 'Gujarat High Court',
          courtNumber: court.courtNumber,
          judgeName: court.judgeName,
          benchType: court.benchType,
          caseList: court.caseList,
          status: court.caseStatus,
          sessionStartTime: court.caseStatus === 'IN_SESSION' ? new Date() : null,
          position: court.queuePosition,
          gsrno: court.gsrno,
          streamUrl: court.streamUrl,
          isLive: court.isLive,
          scrapedAt: new Date(scrapedAt)
        });
      }
    }

    if (historyEntries.length > 0) {
      await CaseHistory.insertMany(historyEntries, { ordered: false }).catch(err => {
        // Ignore duplicate key errors
        if (err.code !== 11000) throw err;
      });
      logger.info(`Saved ${historyEntries.length} case history entries`);
    }
  } catch (error) {
    logger.error('Error saving case history:', error);
  }
}

// Update case statistics
async function updateCaseStatistics(courts) {
  try {
    for (const court of courts) {
      if (!court.caseNumber) continue;

      const stats = await CaseStatistics.findOne({ caseNumber: court.caseNumber });

      if (stats) {
        // Update existing statistics
        stats.lastSeen = new Date();
        stats.totalAppearances += 1;
        
        if (!stats.courts.includes(court.courtNumber)) {
          stats.courts.push(court.courtNumber);
        }
        
        if (!stats.judges.includes(court.judgeName)) {
          stats.judges.push(court.judgeName);
        }
        
        stats.statusHistory.push({
          status: court.caseStatus,
          timestamp: new Date(),
          courtNumber: court.courtNumber,
          queuePosition: court.queuePosition,
          gsrno: court.gsrno
        });

        // Keep only last 100 status history entries to avoid bloat
        if (stats.statusHistory.length > 100) {
          stats.statusHistory = stats.statusHistory.slice(-100);
        }

        // Get watch count
        const watchCount = await Watchlist.countDocuments({ 
          caseNumber: court.caseNumber, 
          isActive: true 
        });
        stats.watchCount = watchCount;

        await stats.save();
      } else {
        // Create new statistics
        const watchCount = await Watchlist.countDocuments({ 
          caseNumber: court.caseNumber, 
          isActive: true 
        });

        await CaseStatistics.create({
          caseNumber: court.caseNumber,
          courthouse: 'Gujarat High Court',
          firstSeen: new Date(),
          lastSeen: new Date(),
          totalAppearances: 1,
          courts: [court.courtNumber],
          judges: [court.judgeName],
          statusHistory: [{
            status: court.caseStatus,
            timestamp: new Date(),
            courtNumber: court.courtNumber,
            queuePosition: court.queuePosition,
            gsrno: court.gsrno
          }],
          watchCount
        });
      }
    }
  } catch (error) {
    logger.error('Error updating case statistics:', error);
  }
}

// Calculate estimated wait time based on historical data
async function calculateEstimatedWaitTime(caseNumber) {
  try {
    const stats = await CaseStatistics.findOne({ caseNumber });
    
    if (!stats || stats.totalAppearances === 0) {
      return null;
    }

    // Get recent case history
    const recentHistory = await CaseHistory.find({
      caseNumber,
      status: 'IN_SESSION',
      sessionStartTime: { $ne: null },
      sessionEndTime: { $ne: null }
    })
    .sort({ createdAt: -1 })
    .limit(10);

    if (recentHistory.length === 0) {
      return null;
    }

    // Calculate average duration
    const totalDuration = recentHistory.reduce((sum, h) => sum + (h.duration || 0), 0);
    const avgDuration = totalDuration / recentHistory.length;

    return Math.round(avgDuration);
  } catch (error) {
    logger.error('Error calculating wait time:', error);
    return null;
  }
}

// Get detailed queue information for a specific court
async function getCourtQueueInfo(courtNumber) {
  try {
    // This would need real-time data
    // For now, return placeholder
    return {
      courtNumber,
      totalCases: 0,
      currentCase: null,
      estimatedTimePerCase: 15 // minutes
    };
  } catch (error) {
    logger.error('Error getting court queue info:', error);
    return null;
  }
}

module.exports = {
  processCaseUpdates,
  calculateEstimatedWaitTime,
  getCourtQueueInfo,
  parseCaseIdentifier,
  findCaseInCourts
};