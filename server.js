require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');
const logger = require('./config/logger');
const apiRoutes = require('./routes/api');
const { initializeWebSocket } = require('./services/websocketService');
const { initializeFirebase } = require('./services/fcmService');
const { 
  startRealtimeScraper, 
  startSnapshotScheduler,
  startCleanupScheduler,
  getScraperStatus
} = require('./services/cronService');

// Create Express app
const app = express();
const server = http.createServer(app);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Routes
app.use('/api', apiRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Court Tracker Backend API',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      'POST /api/device/register': 'Register device with FCM token',
      'POST /api/device/heartbeat': 'Update device last seen',
      'POST /api/watchlist/add': 'Add case to watchlist',
      'GET /api/watchlist/:deviceId': 'Get user watchlist',
      'PUT /api/watchlist/:id': 'Update watchlist item',
      'DELETE /api/watchlist/:id': 'Remove from watchlist',
      'GET /api/courts': 'Get all court data (live)',
      'GET /api/courts/live': 'Get live courts only',
      'GET /api/courts/active': 'Get active courts only',
      'GET /api/courts/:id': 'Get specific court',
      'GET /api/courts/search/:caseNumber': 'Search for case',
      'GET /api/case/history/:caseNumber': 'Get case history',
      'GET /api/case/stats/:caseNumber': 'Get case statistics',
      'GET /api/notifications/:deviceId': 'Get notification history',
      'GET /api/analytics/overview': 'Get analytics overview',
      'GET /api/health': 'Health check'
    },
    websocket: {
      url: `ws://localhost:${process.env.PORT || 3000}`,
      events: {
        'subscribe': 'Subscribe to device updates',
        'subscribe_case': 'Subscribe to case updates',
        'unsubscribe': 'Unsubscribe from updates'
      }
    }
  });
});

// Scraper status endpoint
app.get('/api/scraper/status', (req, res) => {
  const status = getScraperStatus();
  res.json({
    success: true,
    ...status
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Initialize and start server
async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();
    logger.info('✓ MongoDB connected');

    // Initialize Firebase
    initializeFirebase();
    logger.info('✓ Firebase initialized');

    // Initialize WebSocket
    initializeWebSocket(server);
    logger.info('✓ WebSocket initialized');

    // Start scheduled jobs
    startRealtimeScraper();
    logger.info('✓ Realtime scraper started');

    startSnapshotScheduler();
    logger.info('✓ Snapshot scheduler started');

    startCleanupScheduler();
    logger.info('✓ Cleanup scheduler started');

    // Start HTTP server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🏛️  Court Tracker Backend Server                   ║
║                                                       ║
║   Server running on: http://localhost:${PORT}        ║
║   Environment: ${process.env.NODE_ENV || 'development'}                             ║
║   WebSocket: ws://localhost:${PORT}                  ║
║                                                       ║
║   Ready to track cases and send notifications! 🚀    ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer();