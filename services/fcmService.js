const admin = require('firebase-admin');
const logger = require('../config/logger');
const { NotificationLog } = require('../models');
const path = require('path');

// Initialize Firebase Admin
let firebaseApp;

const initializeFirebase = () => {
  try {
    if (!firebaseApp) {
      // Option 1: Using service account file
      if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        let serviceAccountPath;
        
        // Check if it's an absolute path (production) or relative (local)
        if (path.isAbsolute(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
          serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        } else {
          serviceAccountPath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        }
        
        const serviceAccount = require(serviceAccountPath);
        firebaseApp = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      } 
      // Option 2: Using environment variables
      else if (process.env.FIREBASE_PROJECT_ID) {
        firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL
          })
        });
      } else {
        logger.warn('Firebase not configured. Push notifications will not work.');
        return null;
      }
      logger.info('Firebase Admin initialized successfully');
    }
    return firebaseApp;
  } catch (error) {
    logger.error('Error initializing Firebase:', error);
    return null;
  }
};

// Send notification to single device
const sendNotification = async (fcmToken, notification, data = {}) => {
  try {
    const app = initializeFirebase();
    if (!app) {
      throw new Error('Firebase not initialized');
    }

    const message = {
      token: fcmToken,
      notification: {
        title: notification.title,
        body: notification.body
      },
      data: {
        ...data,
        timestamp: new Date().toISOString()
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'court_alerts',
          priority: 'max',
          defaultVibrateTimings: true
        }
      }
    };

    const response = await admin.messaging().send(message);
    logger.info(`Notification sent successfully: ${response}`);
    return { success: true, messageId: response };
  } catch (error) {
    logger.error('Error sending notification:', error);
    return { success: false, error: error.message };
  }
};

// Send notification to multiple devices
const sendMulticastNotification = async (fcmTokens, notification, data = {}) => {
  try {
    const app = initializeFirebase();
    if (!app) {
      throw new Error('Firebase not initialized');
    }

    const message = {
      tokens: fcmTokens,
      notification: {
        title: notification.title,
        body: notification.body
      },
      data: {
        ...data,
        timestamp: new Date().toISOString()
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'court_alerts',
          priority: 'max',
          defaultVibrateTimings: true
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info(`Multicast notification sent. Success: ${response.successCount}, Failed: ${response.failureCount}`);
    return response;
  } catch (error) {
    logger.error('Error sending multicast notification:', error);
    return { successCount: 0, failureCount: fcmTokens.length, error: error.message };
  }
};

// Send case alert notification
const sendCaseAlert = async (deviceId, fcmToken, caseNumber, alertType, details = {}) => {
  let notification = {};
  
  switch (alertType) {
    case 'early_warning':
      notification = {
        title: `⚠️ Case Approaching - ${caseNumber}`,
        body: `Your case is ${details.position || 5} cases away in Court ${details.courtNumber}`
      };
      break;
    
    case 'approaching':
      notification = {
        title: `🔔 Case Next - ${caseNumber}`,
        body: `Your case is next in line in Court ${details.courtNumber}`
      };
      break;
    
    case 'in_session':
      notification = {
        title: `⚖️ Case Started - ${caseNumber}`,
        body: `Your case is now IN SESSION in Court ${details.courtNumber}${details.judgeName ? ' - ' + details.judgeName : ''}`
      };
      break;
    
    case 'completed':
      notification = {
        title: `✅ Case Completed - ${caseNumber}`,
        body: `Your case hearing has ended in Court ${details.courtNumber}`
      };
      break;
    
    default:
      notification = {
        title: `Court Update - ${caseNumber}`,
        body: `Status update for your case`
      };
  }

  const data = {
    type: alertType,
    caseNumber: caseNumber,
    courtNumber: details.courtNumber || '',
    judgeName: details.judgeName || '',
    streamUrl: details.streamUrl || '',
    position: String(details.position || 0)
  };

  const result = await sendNotification(fcmToken, notification, data);

  // Log notification
  await NotificationLog.create({
    deviceId,
    caseNumber,
    notificationType: alertType,
    title: notification.title,
    message: notification.body,
    data: details,
    success: result.success,
    error: result.error || null,
    courtNumber: details.courtNumber,
    position: details.position
  });

  return result;
};

module.exports = {
  initializeFirebase,
  sendNotification,
  sendMulticastNotification,
  sendCaseAlert
};