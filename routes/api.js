const express = require('express');
const router = express.Router();
const { 
  Device, 
  Watchlist, 
  CaseHistory, 
  CaseStatistics, 
  CourtSnapshot,
  NotificationLog 
} = require('../models');
const { scrapeCourtData } = require('../services/scraperService');
const { calculateEstimatedWaitTime } = require('../services/trackingService');
const logger = require('../config/logger');

// ==================== Device Management ====================

// Register or update device
router.post('/device/register', async (req, res) => {
  try {
    const { deviceId, fcmToken, deviceInfo } = req.body;

    if (!deviceId || !fcmToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'deviceId and fcmToken are required' 
      });
    }

    const device = await Device.findOneAndUpdate(
      { deviceId },
      { 
        fcmToken, 
        deviceInfo,
        isActive: true,
        lastSeen: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ 
      success: true, 
      message: 'Device registered successfully',
      device 
    });
  } catch (error) {
    logger.error('Error registering device:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update device last seen
router.post('/device/heartbeat', async (req, res) => {
  try {
    const { deviceId } = req.body;

    await Device.findOneAndUpdate(
      { deviceId },
      { lastSeen: new Date() }
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Watchlist Management ====================

// Add case to watchlist
router.post('/watchlist/add', async (req, res) => {
  try {
    const { deviceId, caseNumber, courthouse, nickname, notificationSettings } = req.body;

    if (!deviceId || !caseNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'deviceId and caseNumber are required' 
      });
    }

    // Check if already exists
    const existing = await Watchlist.findOne({ deviceId, caseNumber, isActive: true });
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        error: 'Case already in watchlist' 
      });
    }

    const watchItem = await Watchlist.create({
      deviceId,
      caseNumber,
      courthouse: courthouse || 'Gujarat High Court',
      nickname,
      notificationSettings: notificationSettings || {
        earlyWarning: true,
        approaching: true,
        inSession: true,
        completed: true
      }
    });

    // Update case statistics watch count
    await CaseStatistics.findOneAndUpdate(
      { caseNumber },
      { $inc: { watchCount: 1 } }
    );

    res.json({ 
      success: true, 
      message: 'Case added to watchlist',
      watchItem 
    });
  } catch (error) {
    logger.error('Error adding to watchlist:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's watchlist
router.get('/watchlist/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const watchlist = await Watchlist.find({ deviceId, isActive: true })
      .sort({ addedAt: -1 });

    // Enrich with current status
    const enrichedWatchlist = await Promise.all(
      watchlist.map(async (item) => {
        const stats = await CaseStatistics.findOne({ caseNumber: item.caseNumber });
        const latestHistory = await CaseHistory.findOne({ caseNumber: item.caseNumber })
          .sort({ createdAt: -1 });

        return {
          ...item.toObject(),
          currentStatus: latestHistory ? {
            status: latestHistory.status,
            courtNumber: latestHistory.courtNumber,
            judgeName: latestHistory.judgeName,
            lastSeen: latestHistory.scrapedAt
          } : null,
          statistics: stats ? {
            totalAppearances: stats.totalAppearances,
            watchCount: stats.watchCount,
            estimatedWaitTime: stats.estimatedWaitTime
          } : null
        };
      })
    );

    res.json({ 
      success: true, 
      count: enrichedWatchlist.length,
      watchlist: enrichedWatchlist 
    });
  } catch (error) {
    logger.error('Error fetching watchlist:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update watchlist item
router.put('/watchlist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nickname, notificationSettings, isActive } = req.body;

    const updateData = {};
    if (nickname !== undefined) updateData.nickname = nickname;
    if (notificationSettings !== undefined) updateData.notificationSettings = notificationSettings;
    if (isActive !== undefined) updateData.isActive = isActive;

    const watchItem = await Watchlist.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    if (!watchItem) {
      return res.status(404).json({ success: false, error: 'Watchlist item not found' });
    }

    res.json({ success: true, watchItem });
  } catch (error) {
    logger.error('Error updating watchlist:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove from watchlist
router.delete('/watchlist/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const watchItem = await Watchlist.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );

    if (!watchItem) {
      return res.status(404).json({ success: false, error: 'Watchlist item not found' });
    }

    // Update case statistics watch count
    await CaseStatistics.findOneAndUpdate(
      { caseNumber: watchItem.caseNumber },
      { $inc: { watchCount: -1 } }
    );

    res.json({ success: true, message: 'Case removed from watchlist' });
  } catch (error) {
    logger.error('Error removing from watchlist:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Court Data ====================

// Get all court data (live scrape)
router.get('/courts', async (req, res) => {
  try {
    const data = await scrapeCourtData();
    res.json(data);
  } catch (error) {
    logger.error('Error fetching courts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get live courts only
router.get('/courts/live', async (req, res) => {
  try {
    const data = await scrapeCourtData();
    const liveCourts = data.courts.filter(c => c.isLive);
    
    res.json({ 
      success: true, 
      scrapedAt: data.scrapedAt,
      total: liveCourts.length,
      courts: liveCourts 
    });
  } catch (error) {
    logger.error('Error fetching live courts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get active courts only
router.get('/courts/active', async (req, res) => {
  try {
    const data = await scrapeCourtData();
    const activeCourts = data.courts.filter(c => c.isActive);
    
    res.json({ 
      success: true, 
      scrapedAt: data.scrapedAt,
      total: activeCourts.length,
      courts: activeCourts 
    });
  } catch (error) {
    logger.error('Error fetching active courts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get specific court by ID
router.get('/courts/:id', async (req, res) => {
  try {
    const data = await scrapeCourtData();
    const court = data.courts.find(c => c.id === req.params.id);
    
    if (!court) {
      return res.status(404).json({ success: false, error: 'Court not found' });
    }
    
    res.json({ success: true, court });
  } catch (error) {
    logger.error('Error fetching court:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search for case
router.get('/courts/search/:caseNumber', async (req, res) => {
  try {
    const { caseNumber } = req.params;
    const data = await scrapeCourtData();
    
    const court = data.courts.find(c => 
      c.caseNumber && c.caseNumber.toLowerCase().includes(caseNumber.toLowerCase())
    );
    
    if (!court) {
      return res.json({ 
        success: true, 
        found: false,
        message: 'Case not currently in session'
      });
    }

    // Calculate queue position
    const sameCourt = data.courts.filter(c => c.courtNumber === court.courtNumber);
    let queueInfo = {
      position: court.queuePosition,
      gsrno: court.gsrno,
      totalInQueue: sameCourt.filter(c => c.queuePosition).length,
      casesAhead: null
    };

    if (court.queuePosition) {
      queueInfo.casesAhead = sameCourt.filter(c => 
        c.queuePosition && 
        c.queuePosition < court.queuePosition &&
        c.caseStatus !== 'SITTING_OVER'
      ).length;
    }
    
    res.json({ 
      success: true, 
      found: true,
      court,
      queueInfo
    });
  } catch (error) {
    logger.error('Error searching case:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get queue status for a specific court
router.get('/courts/:courtNumber/queue', async (req, res) => {
  try {
    const { courtNumber } = req.params;
    const data = await scrapeCourtData();
    
    const courtsInCourt = data.courts.filter(c => c.courtNumber === courtNumber);
    
    if (courtsInCourt.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Court not found' 
      });
    }

    // Build queue
    const queue = courtsInCourt
      .filter(c => c.queuePosition !== null)
      .sort((a, b) => a.queuePosition - b.queuePosition)
      .map(c => ({
        caseNumber: c.caseNumber,
        gsrno: c.gsrno,
        position: c.queuePosition,
        status: c.caseStatus,
        isLive: c.isLive
      }));

    const currentCase = courtsInCourt.find(c => c.caseStatus === 'IN_SESSION');

    res.json({
      success: true,
      courtNumber,
      currentCase: currentCase ? {
        caseNumber: currentCase.caseNumber,
        gsrno: currentCase.gsrno,
        isLive: currentCase.isLive,
        streamUrl: currentCase.streamUrl
      } : null,
      queue,
      totalInQueue: queue.length,
      judgeName: courtsInCourt[0]?.judgeName,
      benchType: courtsInCourt[0]?.benchType
    });
  } catch (error) {
    logger.error('Error fetching court queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Case History ====================

// Get case history
router.get('/case/history/:caseNumber', async (req, res) => {
  try {
    const { caseNumber } = req.params;
    const { limit = 50, skip = 0 } = req.query;

    const history = await CaseHistory.find({ caseNumber })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await CaseHistory.countDocuments({ caseNumber });

    res.json({ 
      success: true, 
      caseNumber,
      total,
      count: history.length,
      history 
    });
  } catch (error) {
    logger.error('Error fetching case history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get case statistics
router.get('/case/stats/:caseNumber', async (req, res) => {
  try {
    const { caseNumber } = req.params;

    const stats = await CaseStatistics.findOne({ caseNumber });
    
    if (!stats) {
      return res.status(404).json({ 
        success: false, 
        error: 'No statistics found for this case' 
      });
    }

    // Calculate estimated wait time
    const estimatedWaitTime = await calculateEstimatedWaitTime(caseNumber);
    
    res.json({ 
      success: true, 
      statistics: {
        ...stats.toObject(),
        estimatedWaitTime
      }
    });
  } catch (error) {
    logger.error('Error fetching case statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Notifications ====================

// Get notification history
router.get('/notifications/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { limit = 50 } = req.query;

    const notifications = await NotificationLog.find({ deviceId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({ 
      success: true, 
      count: notifications.length,
      notifications 
    });
  } catch (error) {
    logger.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Analytics ====================

// Get overall statistics
router.get('/analytics/overview', async (req, res) => {
  try {
    const totalWatchlists = await Watchlist.countDocuments({ isActive: true });
    const totalDevices = await Device.countDocuments({ isActive: true });
    const totalCases = await CaseStatistics.countDocuments({});
    const totalNotifications = await NotificationLog.countDocuments({});

    // Most watched cases
    const mostWatched = await CaseStatistics.find({ watchCount: { $gt: 0 } })
      .sort({ watchCount: -1 })
      .limit(10)
      .select('caseNumber watchCount totalAppearances');

    res.json({ 
      success: true,
      overview: {
        totalWatchlists,
        totalDevices,
        totalCases,
        totalNotifications,
        mostWatchedCases: mostWatched
      }
    });
  } catch (error) {
    logger.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/debug/firebase', (req, res) => {
  res.json({
    hasServiceAccountPath: !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
    hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    privateKeyLength: process.env.FIREBASE_PRIVATE_KEY?.length,
    privateKeyPreview: process.env.FIREBASE_PRIVATE_KEY?.substring(0, 50) + '...'
  });
});

router.post('/debug/test-notification', async (req, res) => {
  try {
    const { deviceId, fcmToken } = req.body;
    
    if (!fcmToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'fcmToken is required' 
      });
    }

    const result = await sendNotification(
      fcmToken,
      { 
        title: '🧪 Test Notification', 
        body: 'This is a test from your Court Tracker API' 
      },
      { test: 'true', timestamp: new Date().toISOString() }
    );

    res.json({ 
      success: true,
      result,
      firebaseConfig: {
        hasServiceAccountPath: !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
        hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
        hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
        hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Court Tracker API'
  });
});

module.exports = router;