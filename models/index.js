const mongoose = require('mongoose');

// ==================== Device Model ====================
const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  fcmToken: {
    type: String,
    required: true
  },
  deviceInfo: {
    model: String,
    osVersion: String,
    appVersion: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastSeen: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// ==================== Watchlist Model ====================
const watchlistSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  caseNumber: {
    type: String,
    required: true,
    index: true
  },
  courthouse: {
    type: String,
    default: 'Gujarat High Court'
  },
  nickname: {
    type: String,
    default: null // User can give a friendly name like "Property Case" or "Client: Sharma"
  },
  notificationSettings: {
    earlyWarning: { type: Boolean, default: true }, // Alert when case is N positions away
    approaching: { type: Boolean, default: true },   // Alert when case is next
    inSession: { type: Boolean, default: true },     // Alert when case starts
    completed: { type: Boolean, default: true }      // Alert when case ends
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastNotificationSent: {
    type: String,
    enum: ['none', 'early_warning', 'approaching', 'in_session', 'completed'],
    default: 'none'
  },
  lastNotificationTime: Date,
  addedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
watchlistSchema.index({ deviceId: 1, caseNumber: 1 }, { unique: true });
watchlistSchema.index({ caseNumber: 1, isActive: 1 });

// ==================== Case History Model ====================
const caseHistorySchema = new mongoose.Schema({
  caseNumber: {
    type: String,
    required: true,
    index: true
  },
  courthouse: {
    type: String,
    default: 'Gujarat High Court'
  },
  courtNumber: String,
  judgeName: String,
  benchType: String,
  caseList: String,
  status: {
    type: String,
    enum: ['IN_SESSION', 'SITTING_OVER', 'RECESS', 'COMPLETED', 'UNKNOWN']
  },
  sessionStartTime: Date,
  sessionEndTime: Date,
  duration: Number, // in minutes
  position: Number, // position in queue if available
  streamUrl: String,
  isLive: Boolean,
  scrapedAt: Date
}, {
  timestamps: true
});

// Index for efficient history queries
caseHistorySchema.index({ caseNumber: 1, createdAt: -1 });
caseHistorySchema.index({ courthouse: 1, createdAt: -1 });

// ==================== Court Snapshot Model ====================
// Stores periodic snapshots of entire court state for analytics
const courtSnapshotSchema = new mongoose.Schema({
  courthouse: {
    type: String,
    default: 'Gujarat High Court'
  },
  snapshotTime: {
    type: Date,
    default: Date.now,
    index: true
  },
  summary: {
    total: Number,
    live: Number,
    active: Number,
    inSession: Number,
    sittingOver: Number,
    recess: Number
  },
  courts: [{
    courtNumber: String,
    judgeName: String,
    caseNumber: String,
    status: String,
    isLive: Boolean
  }]
}, {
  timestamps: true
});

// TTL index - auto delete snapshots older than 90 days
courtSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

// ==================== Case Statistics Model ====================
const caseStatisticsSchema = new mongoose.Schema({
  caseNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  courthouse: String,
  firstSeen: Date,
  lastSeen: Date,
  totalAppearances: {
    type: Number,
    default: 0
  },
  totalDuration: {
    type: Number,
    default: 0 // in minutes
  },
  averageDuration: Number,
  courts: [String], // List of court numbers where case appeared
  judges: [String], // List of judges who heard the case
  statusHistory: [{
    status: String,
    timestamp: Date,
    courtNumber: String
  }],
  estimatedWaitTime: Number, // based on historical data
  watchCount: {
    type: Number,
    default: 0 // how many users are watching this case
  }
}, {
  timestamps: true
});

// ==================== Notification Log Model ====================
const notificationLogSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  caseNumber: {
    type: String,
    required: true,
    index: true
  },
  notificationType: {
    type: String,
    enum: ['early_warning', 'approaching', 'in_session', 'completed', 'error'],
    required: true
  },
  title: String,
  message: String,
  data: mongoose.Schema.Types.Mixed,
  sentAt: {
    type: Date,
    default: Date.now
  },
  success: {
    type: Boolean,
    default: true
  },
  error: String,
  courtNumber: String,
  position: Number
}, {
  timestamps: true
});

// TTL index - auto delete logs older than 30 days
notificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

// ==================== Export Models ====================
module.exports = {
  Device: mongoose.model('Device', deviceSchema),
  Watchlist: mongoose.model('Watchlist', watchlistSchema),
  CaseHistory: mongoose.model('CaseHistory', caseHistorySchema),
  CourtSnapshot: mongoose.model('CourtSnapshot', courtSnapshotSchema),
  CaseStatistics: mongoose.model('CaseStatistics', caseStatisticsSchema),
  NotificationLog: mongoose.model('NotificationLog', notificationLogSchema)
};