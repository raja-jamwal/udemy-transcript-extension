// Initialize state
let recordingState = {
  isRecording: false,
  courseTab: null,
  courseData: null,
  currentSectionIndex: 0,
  currentLectureIndex: 0,
  processedLectures: {},
  transcriptData: {},
  errorCount: 0,
  maxErrors: 5,
  lastError: null
};

// Clear previous state on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ transcriptData: {} });
  console.log('Extension installed/updated: transcript data initialized');
});

// Load any existing transcript data on startup
chrome.storage.local.get(['transcriptData'], (result) => {
  if (result.transcriptData) {
    recordingState.transcriptData = result.transcriptData;
    console.log('Loaded existing transcript data:', Object.keys(result.transcriptData).length, 'sections');
  } else {
    console.log('No existing transcript data found');
  }
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    // Start the recording process
    console.log('Received startRecording request for tab:', message.courseTab);
    
    // Check if we have a valid tab ID
    if (!message.courseTab) {
      const error = 'No course tab ID provided';
      console.error(error);
      recordingState.lastError = error;
      sendResponse({ success: false, error: error });
      return true;
    }
    
    // Check if we're already recording
    if (recordingState.isRecording) {
      const error = 'Already recording in another tab';
      console.error(error);
      recordingState.lastError = error;
      sendResponse({ success: false, error: error });
      return true;
    }
    
    // Set up recording state
    recordingState.isRecording = true;
    recordingState.courseTab = message.courseTab;
    recordingState.errorCount = 0;
    recordingState.lastError = null;
    
    console.log('Starting recording process on tab:', recordingState.courseTab);
    
    // Send message to content script to gather course structure
    try {
      chrome.tabs.sendMessage(recordingState.courseTab, { action: 'getCourseStructure' }, (response) => {
        // Check for chrome runtime error
        if (chrome.runtime.lastError) {
          const error = `Chrome error: ${chrome.runtime.lastError.message}`;
          console.error(error);
          recordingState.isRecording = false;
          recordingState.lastError = error;
          sendResponse({ success: false, error: error });
          return;
        }
        
        // Check response
        if (response && response.success) {
          recordingState.courseData = response.courseData;
          console.log('Received course structure:', recordingState.courseData);
          
          // Validate course data
          if (!recordingState.courseData || !Array.isArray(recordingState.courseData) || recordingState.courseData.length === 0) {
            const error = 'Invalid or empty course structure received';
            console.error(error);
            recordingState.isRecording = false;
            recordingState.lastError = error;
            sendResponse({ success: false, error: error });
            return;
          }
          
          processNextLecture();
          sendResponse({ success: true });
        } else {
          const error = response?.error || 'Failed to get course structure';
          console.error('Failed to get course structure:', error);
          recordingState.isRecording = false;
          recordingState.lastError = error;
          sendResponse({ success: false, error: error });
        }
      });
    } catch (err) {
      const error = `Exception sending message: ${err.message}`;
      console.error(error);
      recordingState.isRecording = false;
      recordingState.lastError = error;
      sendResponse({ success: false, error: error });
    }
    
    return true; // Keep the message channel open for async response
  }
  
  else if (message.action === 'transcriptCaptured') {
    // Save captured transcript data
    if (recordingState.isRecording) {
      const { sectionTitle, lectureTitle, transcript } = message;
      
      // Log the transcript receipt
      console.log(`Received transcript for "${sectionTitle} - ${lectureTitle}"`);
      console.log(`Transcript length: ${transcript.length} lines`);
      
      // Make sure we have the latest transcriptData from storage before updating
      chrome.storage.local.get(['transcriptData'], (result) => {
        let currentData = result.transcriptData || {};
        
        // Initialize section if it doesn't exist
        if (!currentData[sectionTitle]) {
          currentData[sectionTitle] = {};
        }
        
        // Save transcript for this lecture
        currentData[sectionTitle][lectureTitle] = transcript;
        
        // Update local state and storage
        recordingState.transcriptData = currentData;
        chrome.storage.local.set({ transcriptData: currentData }, () => {
          console.log(`Saved transcript for ${sectionTitle} - ${lectureTitle}`);
          console.log(`Storage now has ${Object.keys(currentData).length} sections`);
          
          // Mark as processed
          const key = `${sectionTitle}:${lectureTitle}`;
          recordingState.processedLectures[key] = true;
          
          // Reset error count on successful capture
          recordingState.errorCount = 0;
          
          // Process next lecture
          recordingState.currentLectureIndex++;
          processNextLecture();
        });
      });
      
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not currently recording' });
    }
    
    return true;
  }
  
  else if (message.action === 'processingError') {
    // Handle error during processing
    if (recordingState.isRecording) {
      recordingState.errorCount++;
      console.log(`Processing error: ${message.error}. Error count: ${recordingState.errorCount}`);
      
      // Check if we should stop due to too many errors
      if (recordingState.errorCount >= recordingState.maxErrors) {
        console.error(`Too many errors (${recordingState.errorCount}). Stopping recording process.`);
        stopRecording('Too many consecutive errors');
        sendResponse({ success: false, stopped: true });
      } else {
        // Move to next lecture and continue
        recordingState.currentLectureIndex++;
        processNextLecture();
        sendResponse({ success: true, continued: true });
      }
    } else {
      sendResponse({ success: false, error: 'Not currently recording' });
    }
    
    return true;
  }
  
  else if (message.action === 'stopRecording') {
    const reason = message.reason || 'user request';
    stopRecording(reason);
    sendResponse({ success: true });
    return true;
  }
  
  else if (message.action === 'getRecordingStatus') {
    sendResponse({
      isRecording: recordingState.isRecording,
      currentSectionIndex: recordingState.currentSectionIndex,
      currentLectureIndex: recordingState.currentLectureIndex,
      courseTab: recordingState.courseTab,
      errorCount: recordingState.errorCount,
      lastError: recordingState.lastError
    });
    return true;
  }
  
  else if (message.action === 'clearTranscriptData') {
    chrome.storage.local.set({ transcriptData: {} }, () => {
      recordingState.transcriptData = {};
      sendResponse({ success: true });
    });
    return true;
  }
  
  else if (message.action === 'forceNextLecture') {
    // Emergency recovery - force moving to the next lecture
    console.log('Received forceNextLecture request - emergency recovery');
    
    if (!recordingState.isRecording) {
      console.log('Not recording, cannot force next lecture');
      sendResponse({ success: false, error: 'Not currently recording' });
      return true;
    }
    
    // Increment lecture index and try to continue
    recordingState.currentLectureIndex++;
    recordingState.errorCount++;
    
    console.log(`Forced moving to next lecture. Now at section ${recordingState.currentSectionIndex + 1}, lecture ${recordingState.currentLectureIndex + 1}`);
    console.log(`Error count: ${recordingState.errorCount}/${recordingState.maxErrors}`);
    
    // If too many errors, stop recording
    if (recordingState.errorCount >= recordingState.maxErrors) {
      console.error(`Too many consecutive errors (${recordingState.errorCount}). Stopping recording.`);
      stopRecording('Too many consecutive errors');
      sendResponse({ success: false, stopped: true });
    } else {
      // Try to continue with next lecture
      setTimeout(() => {
        processNextLecture();
      }, 2000); // Add a small delay before continuing
      sendResponse({ success: true });
    }
    
    return true;
  }
  
  // Add a health check endpoint
  else if (message.action === 'checkRecordingHealth') {
    // Check if content script is still responsive
    if (recordingState.isRecording && recordingState.courseTab) {
      try {
        chrome.tabs.sendMessage(recordingState.courseTab, { action: 'pingContentScript' }, (response) => {
          if (chrome.runtime.lastError || !response || !response.alive) {
            console.error('Content script health check failed:', chrome.runtime.lastError || 'No response');
            sendResponse({ healthy: false, error: 'Content script not responding' });
          } else {
            sendResponse({ healthy: true });
          }
        });
      } catch (err) {
        console.error('Error checking content script health:', err);
        sendResponse({ healthy: false, error: err.message });
      }
      return true;
    } else {
      sendResponse({ healthy: !recordingState.isRecording, notRecording: true });
      return true;
    }
  }
});

// Navigate to the next lecture to process
function processNextLecture() {
  if (!recordingState.isRecording || !recordingState.courseData) {
    console.log('Not recording or no course data available');
    return;
  }
  
  const sections = recordingState.courseData;
  
  // Check if we've processed all sections
  if (recordingState.currentSectionIndex >= sections.length) {
    console.log('All sections processed. Finishing recording.');
    finishRecording();
    return;
  }
  
  const currentSection = sections[recordingState.currentSectionIndex];
  
  // Check if we've processed all lectures in this section
  if (recordingState.currentLectureIndex >= currentSection.lectures.length) {
    // Move to next section
    console.log(`Finished section ${recordingState.currentSectionIndex + 1}. Moving to next section.`);
    recordingState.currentSectionIndex++;
    recordingState.currentLectureIndex = 0;
    
    // Reset error count when moving to a new section
    recordingState.errorCount = 0;
    
    processNextLecture();
    return;
  }
  
  const currentLecture = currentSection.lectures[recordingState.currentLectureIndex];
  const key = `${currentSection.section}:${currentLecture.title}`;
  
  // Check if we've already processed this lecture
  if (recordingState.processedLectures[key]) {
    console.log(`Lecture already processed: ${key}. Skipping.`);
    recordingState.currentLectureIndex++;
    processNextLecture();
    return;
  }
  
  console.log(`Processing lecture: Section ${recordingState.currentSectionIndex + 1}, Lecture ${recordingState.currentLectureIndex + 1}`);
  console.log(`Lecture title: ${currentLecture.title}`);
  
  // Send message to content script to navigate to this lecture
  try {
    chrome.tabs.sendMessage(recordingState.courseTab, {
      action: 'navigateToLecture',
      sectionIndex: recordingState.currentSectionIndex,
      lectureIndex: recordingState.currentLectureIndex
    }, (response) => {
      // Check for runtime errors first
      if (chrome.runtime.lastError) {
        console.error('Chrome runtime error:', chrome.runtime.lastError.message);
        handleLectureNavigationError(chrome.runtime.lastError.message);
        return;
      }
      
      if (response && response.success) {
        // Content script will handle navigation and transcript extraction
        // It will send back a 'transcriptCaptured' message when done
        console.log('Navigation request sent successfully');
        
        // Set up watchdog timer - if we don't get a response within 3 minutes, assume something went wrong
        setTimeout(() => {
          // Check if we're still on the same lecture
          chrome.tabs.sendMessage(recordingState.courseTab, { action: 'pingContentScript' }, (pingResponse) => {
            if (chrome.runtime.lastError || !pingResponse) {
              console.error('Watchdog triggered - no response from content script');
              // Force moving to next lecture
              recordingState.errorCount++;
              recordingState.currentLectureIndex++;
              processNextLecture();
            }
          });
        }, 180000); // 3 minutes
      } else {
        console.error('Failed to navigate to lecture:', response?.error);
        handleLectureNavigationError(response?.error || 'Unknown navigation error');
      }
    });
  } catch (err) {
    console.error('Exception sending navigation message:', err);
    handleLectureNavigationError(err.message);
  }
}

// Helper function to handle lecture navigation errors
function handleLectureNavigationError(errorMessage) {
  // Handle error and move to next lecture
  recordingState.errorCount++;
  
  // If too many consecutive errors, stop recording
  if (recordingState.errorCount >= recordingState.maxErrors) {
    console.error(`Too many consecutive errors (${recordingState.errorCount}). Stopping recording.`);
    stopRecording('Too many consecutive errors');
  } else {
    console.log(`Moving to next lecture after error. Error count: ${recordingState.errorCount}`);
    recordingState.currentLectureIndex++;
    
    // Add small delay before moving to next lecture
    setTimeout(() => {
      processNextLecture();
    }, 1000);
  }
}

// Stop the recording process
function stopRecording(reason = 'user request') {
  if (!recordingState.isRecording) {
    return;
  }
  
  console.log(`Stopping recording. Reason: ${reason}`);
  recordingState.isRecording = false;
  
  // Notify content script that recording was stopped
  if (recordingState.courseTab) {
    chrome.tabs.sendMessage(recordingState.courseTab, {
      action: 'stopRecording',
      reason: reason
    });
  }
  
  // Make sure the current progress is saved to storage
  chrome.storage.local.set({ transcriptData: recordingState.transcriptData });
  
  // Reset state but keep transcript data
  recordingState.courseTab = null;
  recordingState.courseData = null;
  recordingState.currentSectionIndex = 0;
  recordingState.currentLectureIndex = 0;
  recordingState.processedLectures = {};
  recordingState.errorCount = 0;
}

// Finish the recording process
function finishRecording() {
  recordingState.isRecording = false;
  
  console.log('Recording process complete! Saving final data.');
  
  // Save final state to storage
  chrome.storage.local.set({ transcriptData: recordingState.transcriptData }, () => {
    // Notify that recording is complete
    chrome.tabs.sendMessage(recordingState.courseTab, {
      action: 'recordingComplete'
    });
    
    // Reset state but keep transcript data
    recordingState.courseTab = null;
    recordingState.courseData = null;
    recordingState.currentSectionIndex = 0;
    recordingState.currentLectureIndex = 0;
    recordingState.processedLectures = {};
    recordingState.errorCount = 0;
  });
} 