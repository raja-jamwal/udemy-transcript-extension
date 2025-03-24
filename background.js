// Initialize state
let recordingState = {
  isRecording: false,
  courseTab: null,
  courseData: null,
  currentSectionIndex: 0,
  currentLectureIndex: 0,
  processedLectures: {},
  transcriptData: {}
};

// Clear previous state on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ transcriptData: {} });
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    // Start the recording process
    recordingState.isRecording = true;
    recordingState.courseTab = message.courseTab;
    
    // Send message to content script to gather course structure
    chrome.tabs.sendMessage(recordingState.courseTab, { action: 'getCourseStructure' }, (response) => {
      if (response && response.success) {
        recordingState.courseData = response.courseData;
        processNextLecture();
        sendResponse({ success: true });
      } else {
        console.error('Failed to get course structure');
        recordingState.isRecording = false;
        sendResponse({ success: false, error: 'Failed to get course structure' });
      }
    });
    
    return true; // Keep the message channel open for async response
  }
  
  else if (message.action === 'transcriptCaptured') {
    // Save captured transcript data
    if (recordingState.isRecording) {
      const { sectionTitle, lectureTitle, transcript } = message;
      
      // Initialize section if it doesn't exist
      if (!recordingState.transcriptData[sectionTitle]) {
        recordingState.transcriptData[sectionTitle] = {};
      }
      
      // Save transcript for this lecture
      recordingState.transcriptData[sectionTitle][lectureTitle] = transcript;
      
      // Mark as processed
      const key = `${sectionTitle}:${lectureTitle}`;
      recordingState.processedLectures[key] = true;
      
      // Save to storage
      chrome.storage.local.set({ transcriptData: recordingState.transcriptData });
      
      // Process next lecture
      recordingState.currentLectureIndex++;
      processNextLecture();
      
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not currently recording' });
    }
    
    return true;
  }
  
  else if (message.action === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }
  
  else if (message.action === 'getRecordingStatus') {
    sendResponse({
      isRecording: recordingState.isRecording,
      currentSectionIndex: recordingState.currentSectionIndex,
      currentLectureIndex: recordingState.currentLectureIndex,
      courseTab: recordingState.courseTab
    });
    return true;
  }
});

// Navigate to the next lecture to process
function processNextLecture() {
  if (!recordingState.isRecording || !recordingState.courseData) {
    return;
  }
  
  const sections = recordingState.courseData;
  
  // Check if we've processed all sections
  if (recordingState.currentSectionIndex >= sections.length) {
    finishRecording();
    return;
  }
  
  const currentSection = sections[recordingState.currentSectionIndex];
  
  // Check if we've processed all lectures in this section
  if (recordingState.currentLectureIndex >= currentSection.lectures.length) {
    // Move to next section
    recordingState.currentSectionIndex++;
    recordingState.currentLectureIndex = 0;
    processNextLecture();
    return;
  }
  
  const currentLecture = currentSection.lectures[recordingState.currentLectureIndex];
  const key = `${currentSection.section}:${currentLecture.title}`;
  
  // Check if we've already processed this lecture
  if (recordingState.processedLectures[key]) {
    recordingState.currentLectureIndex++;
    processNextLecture();
    return;
  }
  
  // Send message to content script to navigate to this lecture
  chrome.tabs.sendMessage(recordingState.courseTab, {
    action: 'navigateToLecture',
    sectionIndex: recordingState.currentSectionIndex,
    lectureIndex: recordingState.currentLectureIndex
  }, (response) => {
    if (response && response.success) {
      // Content script will handle navigation and transcript extraction
      // It will send back a 'transcriptCaptured' message when done
    } else {
      console.error('Failed to navigate to lecture');
      recordingState.currentLectureIndex++;
      processNextLecture();
    }
  });
}

// Stop the recording process
function stopRecording() {
  if (!recordingState.isRecording) {
    return;
  }
  
  recordingState.isRecording = false;
  
  // Notify content script that recording was stopped
  if (recordingState.courseTab) {
    chrome.tabs.sendMessage(recordingState.courseTab, {
      action: 'stopRecording'
    });
  }
  
  // Save the current progress to storage
  chrome.storage.local.set({ transcriptData: recordingState.transcriptData });
  
  // Reset state but keep transcript data
  recordingState.courseTab = null;
  recordingState.courseData = null;
  recordingState.currentSectionIndex = 0;
  recordingState.currentLectureIndex = 0;
  recordingState.processedLectures = {};
}

// Finish the recording process
function finishRecording() {
  recordingState.isRecording = false;
  
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
} 