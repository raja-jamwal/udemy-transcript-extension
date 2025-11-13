// Initialize state
let recordingState = {
  isRecording: false,
  courseTab: null,
  courseData: null, // Will now store API response
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
  
  else if (message.action === 'clearTranscriptData') {
    chrome.storage.local.set({ transcriptData: {} }, () => {
      recordingState.transcriptData = {};
      sendResponse({ success: true });
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
        const apiUrl = `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?curriculum_types=chapter,lecture&page_size=${pageSize}&page=${page}&fields[lecture]=title,object_index,id&fields[chapter]=title,object_index`;
        
        const response = await fetch(apiUrl, {
            headers: { 'Accept': 'application/json, text/plain, */*' }
        });

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        results = results.concat(data.results);
        
        hasMore = !!data.next; // Check if there is a 'next' page URL
        page++;
    }

    // Process the flat list into structured data
    const courseData = { sections: [], lectures: [] };
    let currentSection = { section: 'Course Introduction', lectures: [] };

    results.sort((a, b) => a.object_index - b.object_index); // Ensure correct order

    for (const item of results) {
        if (item._class === 'chapter') {
            // Save the previous section if it has lectures
            if (currentSection.lectures.length > 0) {
                courseData.sections.push(currentSection);
            }
            currentSection = { section: item.title, lectures: [] };
        } else if (item._class === 'lecture') {
            const lectureInfo = {
                id: item.id,
                title: item.title,
                section: currentSection.section
            };
            currentSection.lectures.push(lectureInfo);
            courseData.lectures.push(lectureInfo);
        }
    }
    // Add the last section
    if (currentSection.lectures.length > 0) {
        courseData.sections.push(currentSection);
    }

    return courseData;
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
            
            // Save the transcript
            const { section, title } = lecture;
            if (!recordingState.transcriptData[section]) {
                recordingState.transcriptData[section] = {};
            }
            recordingState.transcriptData[section][title] = transcript;
            chrome.storage.local.set({ transcriptData: recordingState.transcriptData });

            processedCount++;
            console.log(`[${processedCount}/${totalLectures}] Successfully processed: ${title}`);

            // Send progress update to content script
            chrome.tabs.sendMessage(recordingState.courseTab, {
                action: 'updateProgress',
                sectionTitle: section,
                lectureTitle: title,
                processedCount: processedCount,
                totalCount: totalLectures
            });

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
    const lectureApiUrl = `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[asset]=captions`;
    
    const response = await fetch(lectureApiUrl, {
        headers: { 'Accept': 'application/json, text/plain, */*' }
    });

    if (!response.ok) throw new Error(`Lecture API failed with status ${response.status}`);
    
    const data = await response.json();
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
    if (!vttResponse.ok) throw new Error(`VTT fetch failed with status ${vttResponse.status}`);
    
    const vttText = await vttResponse.text();
    return parseVtt(vttText);
}

// New VTT parsing helper
function parseVtt(vttContent) {
    const lines = vttContent.split('\n');
    const transcriptLines = [];
    for (const line of lines) {
        // Skip metadata lines
        if (line.startsWith('WEBVTT') || line.includes('-->') || line.trim() === '') {
            continue;
        }
        // Remove cue identifiers like <v Roger Bingham>
        transcriptLines.push(line.replace(/<[^>]+>/g, '').trim());
    }
    // Join lines that might have been split and remove duplicates
    const uniqueLines = [];
    let previousLine = '';
    for(const line of transcriptLines) {
        if (line !== previousLine) {
            uniqueLines.push(line);
            previousLine = line;
        }
    }
    return uniqueLines;
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
  
  // Save final state to storage
  chrome.storage.local.set({ transcriptData: recordingState.transcriptData }, () => {
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
