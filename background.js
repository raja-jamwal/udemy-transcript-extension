importScripts('lib.js');

// Initialize state
let recordingState = {
  isRecording: false,
  courseTab: null,
  courseId: null,
  courseData: null, // Will now store API response
  transcriptData: {},
  errorCount: 0,
  maxErrors: 5,
  lastError: null,
  hostname: 'www.udemy.com', // Default hostname, updated for Business accounts
  apiRecording: [],
  apiSeq: 0
};

// Helper to record an API call
function recordApiCall(type, url, status, response, lectureId) {
  const entry = {
    seq: recordingState.apiSeq++,
    type: type,
    url: url,
    status: status,
    response: response,
    timestamp: new Date().toISOString()
  };
  if (lectureId !== undefined) {
    entry.lectureId = lectureId;
  }
  recordingState.apiRecording.push(entry);
}

// Migrate: remove old flat keys from previous versions
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['transcriptData', 'apiRecording']);
  console.log('Extension installed/updated: removed legacy flat storage keys');
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
    
    // Set up recording state — clear previous transcript data to avoid cross-course contamination
    recordingState.isRecording = true;
    recordingState.courseTab = message.courseTab;
    recordingState.transcriptData = {};
    recordingState.errorCount = 0;
    recordingState.lastError = null;
    recordingState.apiRecording = [];
    recordingState.apiSeq = 0;
    
    // Ask content script ONLY for the course ID
    chrome.tabs.sendMessage(recordingState.courseTab, { action: 'getCourseStructure' }, (response) => {
        if (chrome.runtime.lastError) {
            const error = `Error communicating with content script: ${chrome.runtime.lastError.message}`;
            stopRecording(error);
            sendResponse({ success: false, error });
            return;
        }
        if (response && response.success) {
            const courseId = response.courseId;
            recordingState.courseId = courseId;
            // Store hostname to support Udemy Business subdomains
            recordingState.hostname = response.hostname || 'www.udemy.com';
            console.log('Using hostname:', recordingState.hostname);
            // Start the new API-based process
            fetchCourseCurriculum(courseId)
                .then(courseData => {
                    recordingState.courseData = courseData;
                    console.log(`Found ${courseData.sections.length} sections and ${courseData.lectures.length} total lectures.`);
                    processLectures(courseId, courseData); // Start processing the lectures
                    sendResponse({ success: true });
                })
                .catch(error => {
                    console.error('Failed to fetch course curriculum:', error);
                    stopRecording(error.message);
                    sendResponse({ success: false, error: error.message });
                });
        } else {
            const error = response?.error || 'Failed to get Course ID from content script.';
            stopRecording(error);
            sendResponse({ success: false, error });
        }
    });
    
    return true; // Keep the message channel open for async response
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
      errorCount: recordingState.errorCount,
      lastError: recordingState.lastError
    });
    return true;
  }
  
  else if (message.action === 'getApiRecording') {
    chrome.storage.local.get(null, (result) => {
      const apiRecordings = {};
      for (const key of Object.keys(result)) {
        if (key.startsWith('apiRecording_')) {
          apiRecordings[key] = result[key];
        }
      }
      sendResponse({ success: true, data: apiRecordings });
    });
    return true;
  }

  else if (message.action === 'clearTranscriptData') {
    chrome.storage.local.get(null, (result) => {
      const keysToRemove = Object.keys(result).filter(
        key => key.startsWith('transcriptData_') || key.startsWith('apiRecording_')
      );
      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove, () => {
          recordingState.transcriptData = {};
          sendResponse({ success: true });
        });
      } else {
        recordingState.transcriptData = {};
        sendResponse({ success: true });
      }
    });
    return true;
  }
});

// New function to fetch the entire course curriculum
async function fetchCourseCurriculum(courseId) {
    const pageSize = 200; // Udemy seems to use a page size of 200
    let page = 1;
    let results = [];
    let hasMore = true;

    while (hasMore) {
        const apiUrl = `https://${recordingState.hostname}/api-2.0/courses/${courseId}/subscriber-curriculum-items/?curriculum_types=chapter,lecture&page_size=${pageSize}&page=${page}&fields[lecture]=title,object_index,id&fields[chapter]=title,object_index`;
        
        const response = await fetch(apiUrl, {
            headers: { 'Accept': 'application/json, text/plain, */*' }
        });

        if (!response.ok) {
            recordApiCall('curriculum', apiUrl, response.status, null);
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        recordApiCall('curriculum', apiUrl, response.status, data);
        results = results.concat(data.results);

        hasMore = !!data.next; // Check if there is a 'next' page URL
        page++;
    }

    return parseCurriculum(results);
}

// New main processing loop
async function processLectures(courseId, courseData) {
    const totalLectures = courseData.lectures.length;
    let processedCount = 0;

    for (const lecture of courseData.lectures) {
        if (!recordingState.isRecording) {
            console.log('Recording stopped, halting lecture processing.');
            break;
        }

        try {
            const transcript = await fetchTranscriptForLecture(courseId, lecture.id);
            
            // Save the transcript with ordering indices
            const { section, title, sectionIndex, lectureIndex } = lecture;
            if (!recordingState.transcriptData[section]) {
                recordingState.transcriptData[section] = {};
            }
            recordingState.transcriptData[section][title] = {
                sectionIndex: sectionIndex,
                lectureIndex: lectureIndex,
                transcript: transcript
            };
            chrome.storage.local.set({ ['transcriptData_' + recordingState.courseId]: recordingState.transcriptData });

            processedCount++;
            console.log(`[${processedCount}/${totalLectures}] Successfully processed: ${title}`);

            // Send progress update to content script (only if still recording)
            if (recordingState.isRecording && recordingState.courseTab) {
                chrome.tabs.sendMessage(recordingState.courseTab, {
                    action: 'updateProgress',
                    sectionTitle: section,
                    lectureTitle: title,
                    processedCount: processedCount,
                    totalCount: totalLectures
                });
            }

        } catch (error) {
            console.error(`Failed to process lecture ${lecture.title}:`, error);
            recordingState.errorCount++;
            if (recordingState.errorCount >= recordingState.maxErrors) {
                stopRecording('Too many consecutive errors.');
                break;
            }
        }
        
        // Add a small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 second delay
    }

    if (recordingState.isRecording) {
        finishRecording();
    }
}

// New function to fetch a single transcript
async function fetchTranscriptForLecture(courseId, lectureId) {
    const lectureApiUrl = `https://${recordingState.hostname}/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[asset]=captions`;
    
    const response = await fetch(lectureApiUrl, {
        headers: { 'Accept': 'application/json, text/plain, */*' }
    });

    if (!response.ok) {
        recordApiCall('captions', lectureApiUrl, response.status, null, lectureId);
        throw new Error(`Lecture API failed with status ${response.status}`);
    }

    const data = await response.json();
    recordApiCall('captions', lectureApiUrl, response.status, data, lectureId);
    const captions = data?.asset?.captions;

    if (!captions || captions.length === 0) {
        return ['[No transcript available for this lecture]'];
    }

    // Find the English caption URL
    let vttUrl = captions.find(c => c.locale_id === 'en_US')?.url
              || captions.find(c => c.locale_id === 'en_GB')?.url
              || captions.find(c => c.locale_id.startsWith('en'))?.url;

    if (!vttUrl) {
        return ['[No English transcript found for this lecture]'];
    }

    const vttResponse = await fetch(vttUrl);
    if (!vttResponse.ok) {
        recordApiCall('vtt', vttUrl, vttResponse.status, null, lectureId);
        throw new Error(`VTT fetch failed with status ${vttResponse.status}`);
    }

    const vttText = await vttResponse.text();
    recordApiCall('vtt', vttUrl, vttResponse.status, vttText, lectureId);
    return parseVtt(vttText);
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
  
  // Build and save the API recording
  const apiRecordingData = {
    metadata: {
      courseId: String(recordingState.courseId || 'unknown'),
      hostname: recordingState.hostname,
      timestamp: new Date().toISOString(),
      totalLectures: recordingState.courseData?.lectures?.length || 0
    },
    requests: recordingState.apiRecording
  };

  // Make sure the current progress is saved to storage (scoped by courseId)
  const courseId = recordingState.courseId || 'unknown';
  chrome.storage.local.set({
    ['transcriptData_' + courseId]: recordingState.transcriptData,
    ['apiRecording_' + courseId]: apiRecordingData
  });

  // Reset state but keep transcript data
  recordingState.courseTab = null;
  recordingState.courseData = null;
  recordingState.errorCount = 0;
}

// Finish the recording process
function finishRecording() {
  recordingState.isRecording = false;
  
  console.log('Recording process complete! Saving final data.');
  
  // Count captured lectures
  let capturedCount = 0;
  let totalSections = 0;
  let missedSections = [];
  
  // Create a map to track which sections/lectures were captured
  const capturedMap = {};
  for (const section in recordingState.transcriptData) {
    totalSections++;
    capturedMap[section] = Object.keys(recordingState.transcriptData[section]).length;
    capturedCount += capturedMap[section];
  }
  
  // Check if any sections from the course structure are missing
  if (recordingState.courseData) {
    for (const section of recordingState.courseData.sections) {
      const sectionTitle = section.section;
      if (!capturedMap[sectionTitle]) {
        missedSections.push(sectionTitle);
      }
    }
  }
  
  console.log(`Transcript capture summary:`);
  console.log(`- Total sections: ${totalSections}`);
  console.log(`- Total lectures captured: ${capturedCount}`);
  if (missedSections.length > 0) {
    console.log(`- Missed sections: ${missedSections.join(', ')}`);
  }
  
  // Build the API recording payload
  const apiRecordingData = {
    metadata: {
      courseId: String(recordingState.courseId || 'unknown'),
      hostname: recordingState.hostname,
      timestamp: new Date().toISOString(),
      totalLectures: capturedCount
    },
    requests: recordingState.apiRecording
  };

  // Save final state to storage (scoped by courseId)
  const courseId = recordingState.courseId || 'unknown';
  chrome.storage.local.set({ ['transcriptData_' + courseId]: recordingState.transcriptData, ['apiRecording_' + courseId]: apiRecordingData }, () => {
    // Notify that recording is complete
    chrome.tabs.sendMessage(recordingState.courseTab, {
      action: 'recordingComplete'
    });

    // Reset state but keep transcript data
    recordingState.courseTab = null;
    recordingState.courseData = null;
    recordingState.errorCount = 0;
  });
}
