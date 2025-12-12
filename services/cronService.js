const cron = require('node-cron');
const { scrapeCourtData } = require('./scraperService');
const { processCaseUpdates } = require('./trackingService');
const { broadcastCourtUpdate } = require('./websocketService');
const { CourtSnapshot } = require('../models');
const logger = require('../config/logger');

let isScraperRunning = false;
let lastScrapeTime = null;
let scrapeCount = 0;

// Main scraping job - runs every 30 seconds during court hours
function startRealtimeScraper() {
  const interval = parseInt(process.env.SCRAPER_INTERVAL) || 30000; // 30 seconds default
  
  logger.info(`Starting realtime scraper with ${interval}ms interval`);
  
  const job = setInterval(async () => {
    if (isScraperRunning) {
      logger.warn('Previous scrape still running, skipping...');
      return;
    }

    try {
      isScraperRunning = true;
      const startTime = Date.now();
      
      logger.info(`Starting scrape #${++scrapeCount}`);
      
      // Scrape court data
      const courtData = await scrapeCourtData();
      
      // Process case updates and send notifications
      await processCaseUpdates(courtData);
      
      // Broadcast to WebSocket clients
      broadcastCourtUpdate(courtData);
      
      lastScrapeTime = new Date();
      const duration = Date.now() - startTime;
      
      logger.info(`Scrape #${scrapeCount} completed in ${duration}ms`);
      
    } catch (error) {
      logger.error('Error in realtime scraper:', error);
    } finally {
      isScraperRunning = false;
    }
  }, interval);

  return job;
}

// Save court snapshot every 5 minutes for analytics
function startSnapshotScheduler() {
  logger.info('Starting snapshot scheduler (every 5 minutes)');
  
  const job = cron.schedule('*/5 * * * *', async () => {
    try {
      logger.info('Taking court snapshot');
      
      const courtData = await scrapeCourtData();
      
      await CourtSnapshot.create({
        courthouse: 'Gujarat High Court',
        snapshotTime: new Date(),
        summary: courtData.summary,
        courts: courtData.courts.map(c => ({
          courtNumber: c.courtNumber,
          judgeName: c.judgeName,
          caseNumber: c.caseNumber,
          status: c.caseStatus,
          isLive: c.isLive
        }))
      });
      
      logger.info('Court snapshot saved successfully');
    } catch (error) {
      logger.error('Error taking court snapshot:', error);
    }
  });

  return job;
}

// Cleanup old data - runs daily at 2 AM
function startCleanupScheduler() {
  logger.info('Starting cleanup scheduler (daily at 2 AM)');
  
  const job = cron.schedule('0 2 * * *', async () => {
    try {
      logger.info('Running daily cleanup');
      
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      // Cleanup is handled by TTL indexes in MongoDB models
      // This is just for additional custom cleanup if needed
      
      logger.info('Daily cleanup completed');
    } catch (error) {
      logger.error('Error in daily cleanup:', error);
    }
  });

  return job;
}

// Get scraper status
function getScraperStatus() {
  return {
    isRunning: isScraperRunning,
    lastScrapeTime,
    scrapeCount,
    interval: parseInt(process.env.SCRAPER_INTERVAL) || 30000
  };
}

module.exports = {
  startRealtimeScraper,
  startSnapshotScheduler,
  startCleanupScheduler,
  getScraperStatus
};