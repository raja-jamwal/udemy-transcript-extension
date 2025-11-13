Of course. Here is a summary of the required changes from a senior software architect's perspective.

---

### **Executive Summary: Architectural Refactoring of the Udemy Transcript Extractor**

The current implementation, which relies on browser automation and DOM scraping, is inherently fragile and inefficient. It is susceptible to breaking with any minor UI change from Udemy and suffers from performance bottlenecks due to page loads and navigation delays.

We will be executing a strategic refactoring to a **headless, API-driven architecture**. This paradigm shift will decouple our extension from Udemy's front-end presentation layer, resulting in a system that is orders of magnitude more **reliable, performant, and maintainable**.

The core principle is to **transform the extension from a "bot" that drives a web page into a "client" that communicates directly with the underlying data API.**

---

### **1. Architectural Blueprint: The New Data Flow**

The system's responsibilities will be re-aligned to enforce a clear separation of concerns:

| Component | Previous Role | **New Role** |
| :--- | :--- | :--- |
| **`background.js`** | State machine managing browser navigation. | **Orchestration & Data-Fetching Core.** It will handle all API communication, data processing, and state management without relying on the DOM. |
| **`content.js`** | Heavy-lifting script for DOM scraping, navigation, and UI. | **Dumb UI Controller.** Its sole responsibilities are to (1) provide the initial Course ID and (2) render progress updates it receives from the background script. |
| **`popup.js`** | User control interface. | **(Unchanged)** Remains the user's primary control interface. |

**The new operational flow will be as follows:**

1.  **Initiation:** User clicks "Start" in the popup.
2.  **ID Acquisition:** `background.js` requests the `courseId` from `content.js`, which parses it from the active tab's URL.
3.  **Curriculum Fetch:** `background.js` makes a single API call to the `/subscriber-curriculum-items` endpoint to retrieve the entire, correctly ordered course structure, including all lecture IDs.
4.  **Queue Processing:** `background.js` iterates through its in-memory lecture queue. For each lecture ID:
    a. It makes an API call to the `/lectures/{id}` endpoint to get asset metadata.
    b. It extracts the `.vtt` file URL from the JSON response.
    c. It fetches the `.vtt` file content.
    d. It parses the VTT text into a clean transcript.
    e. It saves the structured data (`section > lecture > transcript`) to `chrome.storage.local`.
5.  **UI Feedback:** After processing each lecture, `background.js` sends a message to `content.js` with the current progress (`{processedCount, totalCount, lectureTitle}`), which then updates the on-page progress panel.
6.  **Completion:** The process finishes when the queue is empty.

---

### **2. Component-Level Refactoring Plan**

#### **`background.js` - The New Core**

*   **REMOVE:** All logic related to browser navigation and DOM interaction. This includes `processNextLecture`, `handleLectureNavigationError`, and any `chrome.tabs.sendMessage` calls intended to trigger navigation or scraping.
*   **IMPLEMENT:**
    *   A function `fetchCourseCurriculum(courseId)` that handles pagination and retrieves the complete course structure from the `subscriber-curriculum-items` API. It must parse this response to build an ordered queue of all lectures.
    *   A primary processing loop `processLectures(courseQueue)` that iterates through the lectures.
    *   A function `fetchTranscriptForLecture(courseId, lectureId)` that:
        1.  Calls the lecture asset API.
        2.  Fetches the VTT file URL from the response.
        3.  Fetches the VTT content.
    *   A utility function `parseVtt(vttText)` to strip timestamps and metadata, returning a clean array of transcript lines.
*   **MODIFY:**
    *   The `startRecording` message handler to kick off the new `fetchCourseCurriculum` flow instead of the old `getCourseStructure` flow.
    *   The logic to send `updateProgress` messages to the content script from within the main processing loop.

#### **`content.js` - The UI View**

*   **DEPRECATE & REMOVE:** The vast majority of this file's logic. All functions related to scraping and navigation must be deleted:
    *   `extractCourseStructure` and its alternatives.
    *   `navigateToLecture`.
    *   `extractTranscript`.
    *   All `waitForElement` and DOM manipulation helpers.
*   **SIMPLIFY:**
    *   The `getCourseStructure` message handler's only job is now to extract the `courseId` from `window.location.href` and send it back.
*   **ADD:**
    *   A new message listener for `updateProgress` that takes progress data from the background script and uses it to call the existing `updateProgressPanel` function. The UI rendering logic itself can remain.

---

### **3. Key Technical Considerations**

*   **Authentication:** All `fetch` calls from the background script must be configured to send credentials. The browser will automatically attach the necessary `udemy.com` cookies, handling authentication implicitly.
*   **Error Handling:** Each API call (`fetch`) must be wrapped in a `try...catch` block. If a transcript for a single lecture fails, the system should log the error, store an appropriate message for that lecture (e.g., `[Transcript fetch failed]`), and continue to the next one without halting the entire process.
*   **API Rate Limiting:** To act as a good citizen and prevent potential IP blocks, a small, non-blocking delay (e.g., `await new Promise(resolve => setTimeout(resolve, 500))`) should be introduced between consecutive lecture API calls in the main processing loop.

By executing this refactoring, we will pay down significant technical debt and create a foundation that is robust, efficient, and easy to extend with future features like multi-language support.

# Implementation changes

Of course. As requested, here is the implementation diff outlining the specific code changes required to refactor the extension to the new API-driven architecture.

This diff represents the concrete implementation of the architectural plan. It focuses on replacing the fragile DOM-scraping and browser automation logic with direct, efficient API calls, primarily affecting `background.js` and `content.js`.

```diff
--- a/background.js
+++ b/background.js
@@ -2,15 +2,9 @@
 let recordingState = {
   isRecording: false,
   courseTab: null,
-  courseData: null,
-  currentSectionIndex: 0,
-  currentLectureIndex: 0,
-  processedLectures: {},
+  courseData: null, // Will now store API response
   transcriptData: {},
   errorCount: 0,
   maxErrors: 5,
-  lastError: null,
-  currentSectionTitle: '',
-  navigationHistory: []
+  lastError: null
 };
 
 // Clear previous state on extension install/update
@@ -55,108 +49,49 @@
     recordingState.errorCount = 0;
     recordingState.lastError = null;
     
-    console.log('Starting recording process on tab:', recordingState.courseTab);
-    
-    // Send message to content script to gather course structure
-    try {
-      chrome.tabs.sendMessage(recordingState.courseTab, { action: 'getCourseStructure' }, (response) => {
-        // Check for chrome runtime error
-        if (chrome.runtime.lastError) {
-          const error = `Chrome error: ${chrome.runtime.lastError.message}`;
-          console.error(error);
-          recordingState.isRecording = false;
-          recordingState.lastError = error;
-          sendResponse({ success: false, error: error });
-          return;
-        }
-        
-        // Check response
-        if (response && response.success) {
-          recordingState.courseData = response.courseData;
-          console.log('Received course structure:', recordingState.courseData);
-          
-          // Validate course data
-          if (!recordingState.courseData || !Array.isArray(recordingState.courseData) || recordingState.courseData.length === 0) {
-            const error = 'Invalid or empty course structure received';
-            console.error(error);
-            recordingState.isRecording = false;
-            recordingState.lastError = error;
-            sendResponse({ success: false, error: error });
-            return;
-          }
-          
-          // Log course structure for debugging
-          console.log('Course structure summary:');
-          for (let i = 0; i < recordingState.courseData.length; i++) {
-            const section = recordingState.courseData[i];
-            console.log(`Section ${i+1}: ${section.section} - ${section.lectures.length} lectures`);
-          }
-          
-          processNextLecture();
-          sendResponse({ success: true });
-        } else {
-          const error = response?.error || 'Failed to get course structure';
-          console.error('Failed to get course structure:', error);
-          recordingState.isRecording = false;
-          recordingState.lastError = error;
-          sendResponse({ success: false, error: error });
-        }
-      });
-    } catch (err) {
-      const error = `Exception sending message: ${err.message}`;
-      console.error(error);
-      recordingState.isRecording = false;
-      recordingState.lastError = error;
-      sendResponse({ success: false, error: error });
-    }
+    // Ask content script ONLY for the course ID
+    chrome.tabs.sendMessage(recordingState.courseTab, { action: 'getCourseStructure' }, (response) => {
+        if (chrome.runtime.lastError) {
+            const error = `Error communicating with content script: ${chrome.runtime.lastError.message}`;
+            stopRecording(error);
+            sendResponse({ success: false, error });
+            return;
+        }
+        if (response && response.success) {
+            const courseId = response.courseId;
+            // Start the new API-based process
+            fetchCourseCurriculum(courseId)
+                .then(courseData => {
+                    recordingState.courseData = courseData;
+                    console.log(`Found ${courseData.sections.length} sections and ${courseData.lectures.length} total lectures.`);
+                    processLectures(courseId, courseData); // Start processing the lectures
+                    sendResponse({ success: true });
+                })
+                .catch(error => {
+                    console.error('Failed to fetch course curriculum:', error);
+                    stopRecording(error.message);
+                    sendResponse({ success: false, error: error.message });
+                });
+        } else {
+            const error = response?.error || 'Failed to get Course ID from content script.';
+            stopRecording(error);
+            sendResponse({ success: false, error });
+        }
+    });
     
     return true; // Keep the message channel open for async response
   }
   
-  else if (message.action === 'transcriptCaptured') {
-    // Save captured transcript data
-    if (recordingState.isRecording) {
-      const { sectionTitle, lectureTitle, transcript } = message;
-      
-      // Log the transcript receipt
-      console.log(`Received transcript for "${sectionTitle} - ${lectureTitle}"`);
-      console.log(`Transcript length: ${transcript.length} lines`);
-      
-      // Store section title for better tracking
-      if (sectionTitle) {
-        recordingState.currentSectionTitle = sectionTitle;
-      }
-      
-      // Make sure we have the latest transcriptData from storage before updating
-      chrome.storage.local.get(['transcriptData'], (result) => {
-        let currentData = result.transcriptData || {};
-        
-        // Initialize section if it doesn't exist
-        if (!currentData[sectionTitle]) {
-          currentData[sectionTitle] = {};
-          console.log(`Created new section in storage: "${sectionTitle}"`);
-        }
-        
-        // Save transcript for this lecture
-        currentData[sectionTitle][lectureTitle] = transcript;
-        
-        // Update local state and storage
-        recordingState.transcriptData = currentData;
-        chrome.storage.local.set({ transcriptData: currentData }, () => {
-          console.log(`Saved transcript for ${sectionTitle} - ${lectureTitle}`);
-          
-          // Output detailed storage info for debugging
-          let sectionCount = Object.keys(currentData).length;
-          let totalLectures = 0;
-          
-          for (const sect in currentData) {
-            const lectureCount = Object.keys(currentData[sect]).length;
-            totalLectures += lectureCount;
-            console.log(`  Section "${sect}": ${lectureCount} lectures`);
-          }
-          
-          console.log(`Storage now has ${sectionCount} sections with ${totalLectures} total lectures`);
-          
-          // Mark as processed
-          const key = `${sectionTitle}:${lectureTitle}`;
-          recordingState.processedLectures[key] = true;
-          
-          // Reset error count on successful capture
-          recordingState.errorCount = 0;
-          
-          // Process next lecture
-          recordingState.currentLectureIndex++;
-          processNextLecture();
-        });
-      });
-      
-      sendResponse({ success: true });
-    } else {
-      sendResponse({ success: false, error: 'Not currently recording' });
-    }
-    
-    return true;
-  }
-  
-  else if (message.action === 'processingError') {
-    // Handle error during processing
-    if (recordingState.isRecording) {
-      recordingState.errorCount++;
-      console.log(`Processing error: ${message.error}. Error count: ${recordingState.errorCount}`);
-      
-      // Check if we should stop due to too many errors
-      if (recordingState.errorCount >= recordingState.maxErrors) {
-        console.error(`Too many errors (${recordingState.errorCount}). Stopping recording process.`);
-        stopRecording('Too many consecutive errors');
-        sendResponse({ success: false, stopped: true });
-      } else {
-        // Move to next lecture and continue
-        recordingState.currentLectureIndex++;
-        processNextLecture();
-        sendResponse({ success: true, continued: true });
-      }
-    } else {
-      sendResponse({ success: false, error: 'Not currently recording' });
-    }
-    
-    return true;
-  }
-  
   else if (message.action === 'stopRecording') {
     const reason = message.reason || 'user request';
     stopRecording(reason);
@@ -166,11 +101,6 @@
   else if (message.action === 'getRecordingStatus') {
     sendResponse({
       isRecording: recordingState.isRecording,
-      currentSectionIndex: recordingState.currentSectionIndex,
-      currentLectureIndex: recordingState.currentLectureIndex,
-      currentSectionTitle: recordingState.currentSectionTitle || '',
-      courseTab: recordingState.courseTab,
-      courseData: recordingState.courseData, // Include course data for navigation
       errorCount: recordingState.errorCount,
       lastError: recordingState.lastError
     });
@@ -183,115 +113,126 @@
     });
     return true;
   }
-  
-  else if (message.action === 'forceNextLecture') {
-    // Emergency recovery - force moving to the next lecture
-    console.log('Received forceNextLecture request - emergency recovery');
-    
-    if (!recordingState.isRecording) {
-      console.log('Not recording, cannot force next lecture');
-      sendResponse({ success: false, error: 'Not currently recording' });
-      return true;
-    }
-    
-    // Increment lecture index and try to continue
-    recordingState.currentLectureIndex++;
-    recordingState.errorCount++;
-    
-    console.log(`Forced moving to next lecture. Now at section ${recordingState.currentSectionIndex + 1}, lecture ${recordingState.currentLectureIndex + 1}`);
-    console.log(`Error count: ${recordingState.errorCount}/${recordingState.maxErrors}`);
-    
-    // If too many errors, stop recording
-    if (recordingState.errorCount >= recordingState.maxErrors) {
-      console.error(`Too many consecutive errors (${recordingState.errorCount}). Stopping recording.`);
-      stopRecording('Too many consecutive errors');
-      sendResponse({ success: false, stopped: true });
-    } else {
-      // Try to continue with next lecture
-      setTimeout(() => {
-        processNextLecture();
-      }, 2000); // Add a small delay before continuing
-      sendResponse({ success: true });
-    }
-    
-    return true;
-  }
-  
-  // Add a health check endpoint
-  else if (message.action === 'checkRecordingHealth') {
-    // Check if content script is still responsive
-    if (recordingState.isRecording && recordingState.courseTab) {
-      try {
-        chrome.tabs.sendMessage(recordingState.courseTab, { action: 'pingContentScript' }, (response) => {
-          if (chrome.runtime.lastError || !response || !response.alive) {
-            console.error('Content script health check failed:', chrome.runtime.lastError || 'No response');
-            sendResponse({ healthy: false, error: 'Content script not responding' });
-          } else {
-            sendResponse({ healthy: true });
-          }
-        });
-      } catch (err) {
-        console.error('Error checking content script health:', err);
-        sendResponse({ healthy: false, error: err.message });
-      }
-      return true;
-    } else {
-      sendResponse({ healthy: !recordingState.isRecording, notRecording: true });
-      return true;
-    }
-  }
 });
 
-// Navigate to the next lecture to process
-function processNextLecture() {
-  if (!recordingState.isRecording || !recordingState.courseData) {
-    console.log('Not recording or no course data available');
-    return;
-  }
-  
-  const sections = recordingState.courseData;
-  
-  // Check if we've processed all sections
-  if (recordingState.currentSectionIndex >= sections.length) {
-    console.log('All sections processed. Finishing recording.');
-    finishRecording();
-    return;
-  }
-  
-  const currentSection = sections[recordingState.currentSectionIndex];
-  
-  // Update current section title for tracking
-  recordingState.currentSectionTitle = currentSection.section;
-  
-  // Check if we've processed all lectures in this section
-  if (recordingState.currentLectureIndex >= currentSection.lectures.length) {
-    // Move to next section
-    console.log(`Finished section ${recordingState.currentSectionIndex + 1} "${currentSection.section}". Moving to next section.`);
-    recordingState.currentSectionIndex++;
-    recordingState.currentLectureIndex = 0;
-    
-    // Reset error count when moving to a new section
-    recordingState.errorCount = 0;
-    
-    processNextLecture();
-    return;
-  }
-  
-  const currentLecture = currentSection.lectures[recordingState.currentLectureIndex];
-  const key = `${currentSection.section}:${currentLecture.title}`;
-  
-  // Check if we've already processed this lecture
-  if (recordingState.processedLectures[key]) {
-    console.log(`Lecture already processed: ${key}. Skipping.`);
-    recordingState.currentLectureIndex++;
-    processNextLecture();
-    return;
-  }
-  
-  // Track which lecture we're currently processing
-  if (!recordingState.navigationHistory) {
-    recordingState.navigationHistory = [];
-  }
-  
-  // Check for repeated navigation to same lecture
-  const isRepeatedNavigation = recordingState.navigationHistory.length > 5 && 
-    recordingState.navigationHistory.slice(-5).every(item => 
-      item.sectionIndex === recordingState.currentSectionIndex && 
-      item.lectureIndex === recordingState.currentLectureIndex
-    );
-  
-  if (isRepeatedNavigation) {
-    console.warn('Detected repeated navigation to the same lecture. Forcing move to next lecture.');
-    recordingState.currentLectureIndex++;
-    processNextLecture();
-    return;
-  }
-  
-  // Add to navigation history
-  recordingState.navigationHistory.push({
-    sectionIndex: recordingState.currentSectionIndex,
-    lectureIndex: recordingState.currentLectureIndex,
-    timestamp: Date.now()
-  });
-  
-  // Trim history to last 100 entries
-  if (recordingState.navigationHistory.length > 100) {
-    recordingState.navigationHistory = recordingState.navigationHistory.slice(-100);
-  }
-  
-  console.log(`Processing lecture: Section ${recordingState.currentSectionIndex + 1}, Lecture ${recordingState.currentLectureIndex + 1}`);
-  console.log(`Section: "${currentSection.section}", Lecture: "${currentLecture.title}"`);
-  
-  // Send message to content script to navigate to this lecture
-  try {
-    chrome.tabs.sendMessage(recordingState.courseTab, {
-      action: 'navigateToLecture',
-      sectionIndex: recordingState.currentSectionIndex,
-      lectureIndex: recordingState.currentLectureIndex
-    }, (response) => {
-      // Check for runtime errors first
-      if (chrome.runtime.lastError) {
-        console.error('Chrome runtime error:', chrome.runtime.lastError.message);
-        handleLectureNavigationError(chrome.runtime.lastError.message);
-        return;
-      }
-      
-      if (response && response.success) {
-        // Content script will handle navigation and transcript extraction
-        // It will send back a 'transcriptCaptured' message when done
-        console.log('Navigation request sent successfully');
-        
-        // Set up watchdog timer - if we don't get a response within 3 minutes, assume something went wrong
-        setTimeout(() => {
-          // Only check if we're still recording and still on the same lecture
-          if (recordingState.isRecording && 
-              recordingState.currentSectionIndex === recordingState.navigationHistory[recordingState.navigationHistory.length - 1].sectionIndex &&
-              recordingState.currentLectureIndex === recordingState.navigationHistory[recordingState.navigationHistory.length - 1].lectureIndex) {
-            
-            console.log('Watchdog triggered - checking content script status');
-            
-            chrome.tabs.sendMessage(recordingState.courseTab, { action: 'pingContentScript' }, (pingResponse) => {
-              if (chrome.runtime.lastError || !pingResponse) {
-                console.error('Watchdog triggered - no response from content script');
-                // Force moving to next lecture
-                recordingState.errorCount++;
-                recordingState.currentLectureIndex++;
-                processNextLecture();
-              } else {
-                console.log('Content script responsive but taking too long, forcing move to next lecture');
-                recordingState.currentLectureIndex++;
-                processNextLecture();
-              }
-            });
-          }
-        }, 180000); // 3 minutes
-      } else {
-        console.error('Failed to navigate to lecture:', response?.error);
-        handleLectureNavigationError(response?.error || 'Unknown navigation error');
-      }
-    });
-  } catch (err) {
-    console.error('Exception sending navigation message:', err);
-    handleLectureNavigationError(err.message);
-  }
+// New function to fetch the entire course curriculum
+async function fetchCourseCurriculum(courseId) {
+    const pageSize = 200; // Udemy seems to use a page size of 200
+    let page = 1;
+    let results = [];
+    let hasMore = true;
+
+    while (hasMore) {
+        const apiUrl = `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?curriculum_types=chapter,lecture&page_size=${pageSize}&page=${page}&fields[lecture]=title,object_index,id&fields[chapter]=title,object_index`;
+        
+        const response = await fetch(apiUrl, {
+            headers: { 'Accept': 'application/json, text/plain, */*' }
+        });
+
+        if (!response.ok) {
+            throw new Error(`API request failed with status ${response.status}`);
+        }
+
+        const data = await response.json();
+        results = results.concat(data.results);
+        
+        hasMore = !!data.next; // Check if there is a 'next' page URL
+        page++;
+    }
+
+    // Process the flat list into structured data
+    const courseData = { sections: [], lectures: [] };
+    let currentSection = { section: 'Course Introduction', lectures: [] };
+
+    results.sort((a, b) => a.object_index - b.object_index); // Ensure correct order
+
+    for (const item of results) {
+        if (item._class === 'chapter') {
+            // Save the previous section if it has lectures
+            if (currentSection.lectures.length > 0) {
+                courseData.sections.push(currentSection);
+            }
+            currentSection = { section: item.title, lectures: [] };
+        } else if (item._class === 'lecture') {
+            const lectureInfo = {
+                id: item.id,
+                title: item.title,
+                section: currentSection.section
+            };
+            currentSection.lectures.push(lectureInfo);
+            courseData.lectures.push(lectureInfo);
+        }
+    }
+    // Add the last section
+    if (currentSection.lectures.length > 0) {
+        courseData.sections.push(currentSection);
+    }
+
+    return courseData;
+}
+
+// New main processing loop
+async function processLectures(courseId, courseData) {
+    const totalLectures = courseData.lectures.length;
+    let processedCount = 0;
+
+    for (const lecture of courseData.lectures) {
+        if (!recordingState.isRecording) {
+            console.log('Recording stopped, halting lecture processing.');
+            break;
+        }
+
+        try {
+            const transcript = await fetchTranscriptForLecture(courseId, lecture.id);
+            
+            // Save the transcript
+            const { section, title } = lecture;
+            if (!recordingState.transcriptData[section]) {
+                recordingState.transcriptData[section] = {};
+            }
+            recordingState.transcriptData[section][title] = transcript;
+            chrome.storage.local.set({ transcriptData: recordingState.transcriptData });
+
+            processedCount++;
+            console.log(`[${processedCount}/${totalLectures}] Successfully processed: ${title}`);
+
+            // Send progress update to content script
+            chrome.tabs.sendMessage(recordingState.courseTab, {
+                action: 'updateProgress',
+                sectionTitle: section,
+                lectureTitle: title,
+                processedCount: processedCount,
+                totalCount: totalLectures
+            });
+
+        } catch (error) {
+            console.error(`Failed to process lecture ${lecture.title}:`, error);
+            recordingState.errorCount++;
+            if (recordingState.errorCount >= recordingState.maxErrors) {
+                stopRecording('Too many consecutive errors.');
+                break;
+            }
+        }
+        
+        // Add a small delay to avoid overwhelming the API
+        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 second delay
+    }
+
+    if (recordingState.isRecording) {
+        finishRecording();
+    }
+}
+
+// New function to fetch a single transcript
+async function fetchTranscriptForLecture(courseId, lectureId) {
+    const lectureApiUrl = `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[asset]=captions`;
+    
+    const response = await fetch(lectureApiUrl, {
+        headers: { 'Accept': 'application/json, text/plain, */*' }
+    });
+
+    if (!response.ok) throw new Error(`Lecture API failed with status ${response.status}`);
+    
+    const data = await response.json();
+    const captions = data?.asset?.captions;
+
+    if (!captions || captions.length === 0) {
+        return ['[No transcript available for this lecture]'];
+    }
+
+    // Find the English caption URL
+    let vttUrl = captions.find(c => c.locale_id === 'en_US')?.url
+              || captions.find(c => c.locale_id === 'en_GB')?.url
+              || captions.find(c => c.locale_id.startsWith('en'))?.url;
+
+    if (!vttUrl) {
+        return ['[No English transcript found for this lecture]'];
+    }
+
+    const vttResponse = await fetch(vttUrl);
+    if (!vttResponse.ok) throw new Error(`VTT fetch failed with status ${vttResponse.status}`);
+    
+    const vttText = await vttResponse.text();
+    return parseVtt(vttText);
+}
+
+// New VTT parsing helper
+function parseVtt(vttContent) {
+    const lines = vttContent.split('\n');
+    const transcriptLines = [];
+    for (const line of lines) {
+        // Skip metadata lines
+        if (line.startsWith('WEBVTT') || line.includes('-->') || line.trim() === '') {
+            continue;
+        }
+        // Remove cue identifiers like <v Roger Bingham>
+        transcriptLines.push(line.replace(/<[^>]+>/g, '').trim());
+    }
+    // Join lines that might have been split and remove duplicates
+    const uniqueLines = [];
+    let previousLine = '';
+    for(const line of transcriptLines) {
+        if (line !== previousLine) {
+            uniqueLines.push(line);
+            previousLine = line;
+        }
+    }
+    return uniqueLines;
 }
 
-// Helper function to handle lecture navigation errors
-function handleLectureNavigationError(errorMessage) {
-  // Handle error and move to next lecture
-  recordingState.errorCount++;
-  
-  // If too many consecutive errors, stop recording
-  if (recordingState.errorCount >= recordingState.maxErrors) {
-    console.error(`Too many consecutive errors (${recordingState.errorCount}). Stopping recording.`);
-    stopRecording('Too many consecutive errors');
-  } else {
-    console.log(`Moving to next lecture after error. Error count: ${recordingState.errorCount}`);
-    recordingState.currentLectureIndex++;
-    
-    // Add small delay before moving to next lecture
-    setTimeout(() => {
-      processNextLecture();
-    }, 1000);
-  }
-}
-
 // Stop the recording process
 function stopRecording(reason = 'user request') {
   if (!recordingState.isRecording) {
@@ -311,10 +352,7 @@
   // Reset state but keep transcript data
   recordingState.courseTab = null;
   recordingState.courseData = null;
-  recordingState.currentSectionIndex = 0;
-  recordingState.currentLectureIndex = 0;
-  recordingState.processedLectures = {};
   recordingState.errorCount = 0;
 }
 
@@ -338,8 +376,8 @@
   
   // Check if any sections from the course structure are missing
   if (recordingState.courseData) {
-    for (const section of recordingState.courseData) {
-      const sectionTitle = section.section;
+    for (const section of recordingState.courseData.sections) {
+      const sectionTitle = section.title;
       if (!capturedMap[sectionTitle]) {
         missedSections.push(sectionTitle);
       }
@@ -361,11 +399,7 @@
     // Reset state but keep transcript data
     recordingState.courseTab = null;
     recordingState.courseData = null;
-    recordingState.currentSectionIndex = 0;
-    recordingState.currentLectureIndex = 0;
-    recordingState.currentSectionTitle = '';
-    recordingState.processedLectures = {};
     recordingState.errorCount = 0;
   });
-} 
+}
\ No newline at end of file
--- a/content.js
+++ b/content.js
@@ -6,8 +6,6 @@
   processedCount: 0,
   totalCount: 0
 };
-let retryCount = 0;
-const MAX_RETRIES = 3;
 
 // Listen for messages from the background script
 chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
@@ -15,159 +13,40 @@
     console.log('Received getCourseStructure request');
     
     // Check if we're on a course page
-    if (!window.location.href.includes('/course/') && !window.location.href.includes('/learn/')) {
+    const courseIdMatch = window.location.href.match(/\/course\/(\d+)/);
+    if (!courseIdMatch || !courseIdMatch[1]) {
       console.error('Not on a Udemy course page');
-      sendResponse({ success: false, error: 'Not on a Udemy course page. Please navigate to a Udemy course.' });
+      sendResponse({ success: false, error: 'Could not find Course ID in the URL. Please navigate to a course page.' });
       return true;
     }
+    const courseId = courseIdMatch[1];
+    console.log('Found Course ID:', courseId);
     
-    // Extract course structure from the sidebar
-    extractCourseStructure()
-      .then(courseData => {
-        // Calculate total lectures
-        const totalLectures = courseData.reduce((total, section) => total + section.lectures.length, 0);
-        currentProgress.totalCount = totalLectures;
-        
-        // Create progress panel
-        createProgressPanel();
-        updateProgressPanel('Initializing...');
-        
-        // Debug log the course structure
-        console.log('Course structure extracted:', courseData);
-        console.log(`Found ${courseData.length} sections with a total of ${totalLectures} lectures`);
-        
-        sendResponse({ success: true, courseData });
-      })
-      .catch(error => {
-        console.error('Error extracting course structure:', error);
-        console.log('DOM at time of error:', document.body.innerHTML.substring(0, 500) + '...');
-        
-        // Try alternative extraction method
-        console.log('Attempting alternative extraction method...');
-        extractCourseStructureAlternative()
-          .then(courseData => {
-            if (courseData && courseData.length > 0) {
-              console.log('Alternative extraction successful!');
-              const totalLectures = courseData.reduce((total, section) => total + section.lectures.length, 0);
-              currentProgress.totalCount = totalLectures;
-              createProgressPanel();
-              sendResponse({ success: true, courseData });
-            } else {
-              sendResponse({ 
-                success: false, 
-                error: `Failed to extract course structure: ${error.message}. Please try refreshing the page.`
-              });
-            }
-          })
-          .catch(altError => {
-            console.error('Alternative extraction also failed:', altError);
-            sendResponse({ 
-              success: false, 
-              error: `Failed to extract course structure: ${error.message}. Alternative method also failed: ${altError.message}`
-            });
-          });
-      });
+    // Create progress panel
+    createProgressPanel();
+    updateProgressPanel('Fetching course curriculum...');
+    
+    sendResponse({ success: true, courseId: courseId });
     
     return true; // Keep the message channel open for async response
   }
   
-  else if (message.action === 'navigateToLecture') {
-    // Update progress information
-    currentProgress.processedCount++;
-    
-    // Reset retry count for each new lecture
-    retryCount = 0;
-    
-    // Navigate to the specified lecture
-    navigateToLecture(message.sectionIndex, message.lectureIndex)
-      .then(({ sectionTitle, lectureTitle }) => {
-        currentProgress.currentSection = sectionTitle;
-        currentProgress.currentLecture = lectureTitle;
-        
-        // Update progress panel
-        updateProgressPanel('Recording transcript...');
-        
-        isRecordingTranscript = true;
-        // Wait for page to load and then extract transcript
-        setTimeout(() => {
-          extractTranscript()
-            .then(({ sectionTitle, lectureTitle, transcript }) => {
-              // Send transcript data back to background script
-              chrome.runtime.sendMessage({
-                action: 'transcriptCaptured',
-                sectionTitle,
-                lectureTitle,
-                transcript
-              }, (response) => {
-                // Check if message was sent successfully
-                if (chrome.runtime.lastError) {
-                  console.error('Error sending transcript:', chrome.runtime.lastError);
-                  // Force continue to next lecture after error
-                  forceNextLecture(sectionTitle, lectureTitle, 
-                    `[Error sending transcript: ${chrome.runtime.lastError.message}]`);
-                }
-                isRecordingTranscript = false;
-              });
-            })
-            .catch(error => {
-              console.error('Error extracting transcript:', error);
-              isRecordingTranscript = false;
-              updateProgressPanel('Error extracting transcript, moving to next lecture...');
-              
-              // Continue to next lecture even if transcript extraction fails
-              forceNextLecture(currentProgress.currentSection, currentProgress.currentLecture, 
-                `[Could not extract transcript: ${error.message}]`);
-            });
-        }, 8000); // Increase wait time to 8 seconds for page to fully load
-        
-        sendResponse({ success: true });
-      })
-      .catch(error => {
-        console.error('Error navigating to lecture:', error);
-        updateProgressPanel(`Error navigating to lecture: ${error.message}`);
-        
-        // Try again if under max retries
-        if (retryCount < MAX_RETRIES) {
-          retryCount++;
-          updateProgressPanel(`Retrying... (${retryCount}/${MAX_RETRIES})`);
-          
-          // Wait and retry
-          setTimeout(() => {
-            navigateToLecture(message.sectionIndex, message.lectureIndex)
-              .then(({ sectionTitle, lectureTitle }) => {
-                // Continue with normal process
-                // (similar code as above, but simplified for retry)
-                extractTranscript()
-                  .then(({ transcript }) => {
-                    chrome.runtime.sendMessage({
-                      action: 'transcriptCaptured',
-                      sectionTitle,
-                      lectureTitle,
-                      transcript
-                    }, (response) => {
-                      // Check for errors in response
-                      if (chrome.runtime.lastError) {
-                        forceNextLecture(sectionTitle, lectureTitle, 
-                          `[Error sending transcript on retry: ${chrome.runtime.lastError.message}]`);
-                      }
-                    });
-                  })
-                  .catch(err => {
-                    // Skip this lecture if extraction fails on retry
-                    forceNextLecture(sectionTitle, lectureTitle, 
-                      `[Transcript extraction failed after retry: ${err.message}]`);
-                  });
-              })
-              .catch(retryError => {
-                // If retry also fails, send error and move to next lecture
-                console.error('Retry failed:', retryError);
-                const sectionName = `Section ${message.sectionIndex + 1}`;
-                const lectureName = `Lecture ${message.lectureIndex + 1}`;
-                forceNextLecture(sectionName, lectureName, 
-                  `[Navigation failed after retry: ${retryError.message}]`);
-              });
-          }, 5000);
-        } else {
-          // Skip this lecture after max retries
-          const sectionName = `Section ${message.sectionIndex + 1}`;
-          const lectureName = `Lecture ${message.lectureIndex + 1}`;
-          forceNextLecture(sectionName, lectureName, 
-            `[Navigation failed after ${MAX_RETRIES} retries: ${error.message}]`);
-        }
-        
-        sendResponse({ success: false, error: error.message });
-      });
-    
-    return true;
+  // NEW: Listener for progress updates from the background script
+  else if (message.action === 'updateProgress') {
+    currentProgress.currentSection = message.sectionTitle;
+    currentProgress.currentLecture = message.lectureTitle;
+    currentProgress.processedCount = message.processedCount;
+    currentProgress.totalCount = message.totalCount;
+    updateProgressPanel(`Recording: ${message.lectureTitle}`);
+    sendResponse({ success: true });
+    return true;
   }
   
   else if (message.action === 'recordingComplete') {
@@ -209,165 +88,8 @@
     stopRecording();
     sendResponse({ success: true });
     return true;
-  }
-
-  // Add a new handler for checking content script health
-  if (message.action === 'pingContentScript') {
-    sendResponse({ alive: true });
-    return true;
   }
 });
-
-// Helper function to wait for section expansion
-async function waitForSectionExpansion(section, maxWaitTime = 5000) {
-  const startTime = Date.now();
-  
-  while (Date.now() - startTime < maxWaitTime) {
-    // Look for any element with class containing 'accordion-panel'
-    const panel = section.querySelector('button.js-panel-toggler');
-    if (panel) {
-      // Check if it's expanded either through aria-hidden or aria-expanded
-      const isExpanded = panel.getAttribute('aria-expanded') === 'true';
-      
-      if (isExpanded) {
-        return true;
-      }
-    }
-    
-    await new Promise(resolve => setTimeout(resolve, 100));
-  }
-  return false;
-}
-
-// Extract course structure from the sidebar
-async function extractCourseStructure() {
-  console.log('Starting course structure extraction...');
-  
-  // Check if we're on a course page
-  if (!window.location.href.includes('/course/') && !window.location.href.includes('/learn/')) {
-    throw new Error('Not on a Udemy course page');
-  }
-  
-  // Debug current page
-  console.log('Current URL:', window.location.href);
-  console.log('Page title:', document.title);
-  
-  try {
-    // Wait for the sidebar to be visible with increased timeout
-    console.log('Waiting for sidebar...');
-    await waitForElement('[data-purpose="sidebar"], .ud-component--course-taking--curriculum-sidebar', 30000);
-    console.log('Sidebar found!');
-    
-    // Ensure the sidebar is properly loaded
-    await new Promise(resolve => setTimeout(resolve, 2000));
-    
-    // Try to expand all sections first - this is critical
-    console.log('Expanding all course sections...');
-    const expandButtons = document.querySelectorAll(
-      '[data-purpose="expand-all"], ' + 
-      'button[aria-label="Expand all sections"], ' +
-      'button.ud-btn-ghost[aria-label*="all sections"]'
-    );
-    
-    // If we find an expand all button, click it
-    if (expandButtons && expandButtons.length > 0) {
-      console.log('Found "Expand All" button, clicking it...');
-      expandButtons[0].click();
-      // Wait for all sections to expand
-      await new Promise(resolve => setTimeout(resolve, 3000));
-    } else {
-      console.log('No "Expand All" button found, will expand sections manually');
-    }
-    
-    // Get sections with better selector options - use multiple selectors for different Udemy UI versions
-    console.log('Looking for course sections...');
-    const sections = document.querySelectorAll(
-      '[data-purpose^="section-panel-"]'
-    );
-    
-    if (!sections || sections.length === 0) {
-      console.error('No sections found with primary selectors');
-      throw new Error('No course sections found. The page structure may have changed.');
-    }
-    
-    console.log(`Found ${sections.length} course sections`);
-    
-    // Try to expand all sections manually as a backup
-    for (const section of sections) {
-      try {
-        const toggleBtn = section.querySelector(
-          'button.js-panel-toggler'
-        );
-        
-        if (!toggleBtn) {
-          console.log(`No toggle button found for a section ${section.innerText.trim()}, may already be expanded`);
-          continue;
-        }
-        
-        const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
-        
-        if (!isExpanded) {
-          console.log('Expanding a collapsed section...');
-          toggleBtn.click();
-          // Wait for the section to expand
-          const expanded = await waitForSectionExpansion(section);
-          if (!expanded) {
-            console.warn('Section did not expand within timeout');
-          }
-        }
-      } catch (err) {
-        console.warn('Error expanding section:', err);
-        // Continue with other sections
-      }
-    }
-    
-    // Wait additional time for all sections to expand
-    await new Promise(resolve => setTimeout(resolve, 3000));
-    
-    // DEBUG: Log all the section titles we found to help diagnose issues
-    console.log('Section titles found:');
-    for (const section of sections) {
-      try {
-        const sectionTitle = 
-          section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() ||
-          section.querySelector('[data-purpose="section-title"]')?.innerText.trim() ||
-          section.querySelector('h3')?.innerText.trim() ||
-          section.querySelector('.section-title')?.innerText.trim() ||
-          'Unknown Section';
-        console.log(` - ${sectionTitle}`);
-      } catch (err) {
-        console.log(' - [Error getting section title]');
-      }
-    }
-    
-    // Now extract the data with improved selectors
-    const courseData = [];
-    
-    // Debug what we're working with
-    console.log('Section elements found:', sections.length);
-    if (sections.length > 0) {
-      console.log('First section HTML structure:', sections[0].outerHTML.substring(0, 500) + '...');
-    }
-    
-    for (const section of sections) {
-      try {
-        // Try multiple selectors for the section title with better fallbacks
-        const sectionTitle = 
-          section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() ||
-          section.querySelector('[data-purpose="section-title"]')?.innerText.trim() ||
-          section.querySelector('h3')?.innerText.trim() ||
-          section.querySelector('button[data-purpose*="toggle"]')?.innerText.trim() || 
-          section.querySelector('.section-title')?.innerText.trim() ||
-          section.querySelector('[class*="title"]')?.innerText.trim() ||
-          `Section ${courseData.length + 1}`;
-        
-        // Handle duplicate section titles by appending a number
-        let finalSectionTitle = sectionTitle;
-        let dupCounter = 1;
-        while (courseData.some(s => s.section === finalSectionTitle)) {
-          finalSectionTitle = `${sectionTitle} (${dupCounter++})`;
-        }
-        
-        // Try multiple selectors for lectures with more fallbacks
-        let lectures = Array.from(
-          section.querySelectorAll(
-            '[data-purpose^="curriculum-item-"], ' +
-            '.ud-block-list-item, ' +
-            '.curriculum-item-link, ' +
-            'div[class*="item--"], ' +
-            '[data-purpose*="lecture"], ' +
-            '[id^="lecture-"]'
-          )
-        );
-        
-        console.log(`Section "${finalSectionTitle}" has ${lectures.length} items`);
-        
-        // If we got nothing, retry the original approach up to 3 times
-        let retryCount = 0;
-        const MAX_RETRIES = 3;
-        
-        while (lectures.length === 0 && retryCount < MAX_RETRIES) {
-          console.warn(`No lectures found in section "${finalSectionTitle}" - retry attempt ${retryCount + 1}/${MAX_RETRIES}`);
-          
-          // Wait a bit before retrying
-          await new Promise(resolve => setTimeout(resolve, 2000));
-          
-          // Ensure section is expanded
-          const toggleBtn = section.querySelector(
-            'button.js-panel-toggler, ' +
-            '[aria-expanded], ' +
-            '.ud-accordion-panel-toggler, ' + 
-            'button[aria-label*="Expand"], ' +
-            'button[data-purpose*="toggle"]'
-          );
-          
-          if (toggleBtn && toggleBtn.getAttribute('aria-expanded') === 'false') {
-            console.log('Section appears collapsed, expanding before retry...');
-            toggleBtn.click();
-            await waitForSectionExpansion(section);
-          }
-          
-          // Retry the original query
-          lectures = Array.from(
-            section.querySelectorAll(
-              '[data-purpose^="curriculum-item-"], ' +
-              '.ud-block-list-item, ' +
-              '.curriculum-item-link, ' +
-              'div[class*="item--"], ' +
-              '[data-purpose*="lecture"], ' +
-              '[id^="lecture-"]'
-            )
-          );
-          
-          console.log(`Retry ${retryCount + 1} found ${lectures.length} items`);
-          retryCount++;
-        }
-        
-        if (lectures.length === 0) {
-          console.warn(`No lectures found in section "${finalSectionTitle}" after ${MAX_RETRIES} retries`);
-        }
-        
-        const lectureData = lectures.map(lecture => {
-          try {
-            // Title with much more fallback options
-            const title = 
-              lecture.querySelector('[data-purpose="item-title"]')?.innerText.trim() ||
-              lecture.querySelector('[data-purpose^="title"]')?.innerText.trim() ||
-              lecture.querySelector('.ud-block-list-item-content')?.innerText.trim() ||
-              lecture.querySelector('.item-title')?.innerText.trim() ||
-              lecture.querySelector('span[class*="title"]')?.innerText.trim() ||
-              lecture.querySelector('a')?.innerText.trim() ||
-              lecture.innerText.trim().split('\n')[0] ||
-              'Untitled Lecture';
-            
-            // Extract duration with more fallbacks
-            const duration = 
-              lecture.querySelector('.curriculum-item-link--metadata--XK804 span')?.innerText.trim() ||
-              lecture.querySelector('[data-purpose="item-content-summary"]')?.innerText.trim() ||
-              lecture.querySelector('[data-purpose*="duration"]')?.innerText.trim() ||
-              lecture.querySelector('span[class*="duration"]')?.innerText.trim() ||
-              Array.from(lecture.querySelectorAll('span'))
-                .find(span => /^\d+:\d+$/.test(span.innerText.trim()))?.innerText.trim() ||
-              '';
-            
-            // Enhanced video detection
-            const isVideo = 
-              !!lecture.querySelector('button[aria-label^="Play"]') ||
-              !!lecture.querySelector('[data-purpose="play-button"]') ||
-              !!lecture.querySelector('.udi-play') ||
-              !!lecture.querySelector('svg[class*="play"]') ||
-              !!lecture.querySelector('i[class*="play"]') ||
-              !!lecture.querySelector('img[alt*="Video"]') ||
-              lecture.textContent.includes('Video') ||
-              lecture.textContent.includes('video') ||
-              // Duration pattern is a good indicator of video content
-              /^\d+:\d+$/.test(duration);
-            
-            return { 
-              title: title || 'Untitled Lecture', 
-              duration, 
-              isVideo,
-              element: lecture // Keep reference to the DOM element for later
-            };
-          } catch (err) {
-            console.warn('Error processing a lecture item:', err);
-            return { title: 'Error Lecture', duration: '', isVideo: false, element: lecture };
-          }
-        });
-        
-        // Consider all items as potential videos if we can't detect specifically
-        let videoLectures = lectureData.filter(lecture => lecture.isVideo);
-        
-        // If no videos detected, but we have items with duration, treat them as videos
-        if (videoLectures.length === 0 && lectureData.some(l => l.duration)) {
-          console.log(`No videos detected in "${finalSectionTitle}" but found items with duration - treating as videos`);
-          videoLectures = lectureData.filter(l => l.duration);
-        }
-        
-        // Last resort - if still nothing, include all items that look like content
-        if (videoLectures.length === 0 && lectures.length > 0) {
-          console.log(`No clear videos in "${finalSectionTitle}" - including all items as potential content`);
-          videoLectures = lectureData.filter(l => 
-            !l.title.toLowerCase().includes('quiz') && 
-            !l.title.toLowerCase().includes('exercise') && 
-            !l.title.toLowerCase().includes('assignment')
-          );
-        }
-        
-        console.log(`Section "${finalSectionTitle}" has ${videoLectures.length} video lectures`);
-        
-        // Only include sections with lectures to avoid empty sections
-        if (videoLectures.length > 0) {
-          // Remove element references before storing
-          const cleanLectures = videoLectures.map(({ title, duration, isVideo }) => ({ title, duration, isVideo }));
-          
-          courseData.push({
-            section: finalSectionTitle,
-            lectures: cleanLectures,
-            originalElements: videoLectures // Keep for debugging/navigation
-          });
-        } else {
-          console.warn(`No video lectures found in section "${finalSectionTitle}"`);
-        }
-      } catch (err) {
-        console.warn('Error processing a section:', err);
-        // Continue with other sections
-      }
-    }
-    
-    // Log counts and validate
-    console.log(`Finished processing course structure. Found ${courseData.length} sections with content.`);
-    let totalLectures = 0;
-    for (const section of courseData) {
-      totalLectures += section.lectures.length;
-      console.log(`- ${section.section}: ${section.lectures.length} lectures`);
-    }
-    console.log(`Total lectures to process: ${totalLectures}`);
-    
-    if (courseData.length === 0) {
-      throw new Error('No course sections with video lectures found. Please make sure you are on a course content page.');
-    }
-    
-    return courseData;
-  } catch (error) {
-    console.error('Error in extractCourseStructure:', error);
-    throw error;
-  }
-}
-
-// Process alternative section elements when standard selectors fail
-async function processAlternativeSections(sections) {
-  console.log('Processing alternative sections...');
-  
-  const courseData = [];
-  let sectionCounter = 1;
-  
-  // Try to expand all possible sections first
-  for (const section of sections) {
-    try {
-      const toggles = section.querySelectorAll('button, [aria-expanded], [data-purpose*="toggle"]');
-      for (const toggle of toggles) {
-        if (toggle.getAttribute('aria-expanded') === 'false') {
-          console.log('Expanding alternative section...');
-          toggle.click();
-          await new Promise(resolve => setTimeout(resolve, 500));
-        }
-      }
-    } catch (err) {
-      console.warn('Error expanding alternative section:', err);
-    }
-  }
-  
-  // Wait for expansions to complete
-  await new Promise(resolve => setTimeout(resolve, 2000));
-  
-  // Process each section
-  for (const section of sections) {
-    try {
-      // Try to get section title with many fallbacks
-      const sectionTitle = 
-        section.querySelector('h1, h2, h3, h4, h5')?.innerText.trim() ||
-        section.querySelector('.title, [class*="title"]')?.innerText.trim() ||
-        section.querySelector('button[aria-expanded]')?.innerText.trim() ||
-        `Section ${sectionCounter++}`;
-      
-      // Look for any elements that might be lecture items with more aggressive selectors
-      const possibleLectures = Array.from(
-        section.querySelectorAll(
-          'li, ' + 
-          'div[class*="item"], ' + 
-          'div[class*="lecture"], ' + 
-          'a[href*="lecture"], ' +
-          '[data-purpose*="item"], ' +
-          '[class*="lesson"], ' +
-          '.ud-block-list-item'
-        )
-      );
-      
-      console.log(`Alternative section "${sectionTitle}" has ${possibleLectures.length} potential lectures`);
-      
-      // Filter to likely video lectures with much more forgiving criteria
-      const videoLectures = possibleLectures
-        .filter(item => {
-          // Various indicators that this might be a video
-          const hasPlayIcon = !!item.querySelector('svg, i[class*="play"], span[class*="play"]');
-          const mentionsVideo = item.textContent.toLowerCase().includes('video');
-          const hasTime = /\d+:\d+/.test(item.textContent); // Looks for time format like 5:23
-          const hasVideoElement = !!item.querySelector('video');
-          const hasVideoClass = item.className.toLowerCase().includes('video');
-          const isNotQuiz = !item.textContent.toLowerCase().includes('quiz');
-          const isNotExercise = !item.textContent.toLowerCase().includes('exercise');
-          
-          // Consider it a video if it has any video-like properties and isn't clearly non-video content
-          return (hasPlayIcon || mentionsVideo || hasTime || hasVideoElement || hasVideoClass) && 
-                  isNotQuiz && isNotExercise;
-        })
-        .map(lecture => {
-          // Extract title with fallbacks
-          const title = lecture.querySelector('h3, h4, span[class*="title"]')?.innerText.trim() || 
-                        lecture.textContent.split('\n')[0].trim() || 
-                        'Untitled Lecture';
-          
-          // Try to find duration
-          const durationMatch = lecture.textContent.match(/(\d+:\d+)/);
-          const duration = durationMatch ? durationMatch[0] : '';
-          
-          return { 
-            title: title.substring(0, 100) || 'Untitled Lecture', // Limit title length
-            duration, 
-            isVideo: true,
-            element: lecture
-          };
-        });
-      
-      // If we have lectures for this section, add it to course data
-      if (videoLectures.length > 0) {
-        // Clean up data for storage (remove DOM references)
-        const cleanLectures = videoLectures.map(({ title, duration, isVideo }) => ({ title, duration, isVideo }));
-        
-        courseData.push({
-          section: sectionTitle,
-          lectures: cleanLectures,
-          originalElements: videoLectures
-        });
-      }
-    } catch (err) {
-      console.warn('Error processing alternative section:', err);
-    }
-  }
-  
-  return courseData;
-}
-
-// Navigate to a specific lecture
-async function navigateToLecture(sectionIndex, lectureIndex) {
-  console.log(`Navigating to section ${sectionIndex + 1}, lecture ${lectureIndex + 1}...`);
-  
-  // Wait for the sidebar to be visible with increased timeout
-  try {
-    await waitForElement('[data-purpose="sidebar"], .ud-component--course-taking--curriculum-sidebar', 30000);
-    console.log('Sidebar found for navigation');
-    
-    // Get course data from the background script
-    const recordingStatus = await new Promise(resolve => {
-      chrome.runtime.sendMessage({action: 'getRecordingStatus'}, result => resolve(result));
-    });
-    
-    if (!recordingStatus || !recordingStatus.isRecording) {
-      throw new Error('Recording has stopped');
-    }
-    
-    const courseData = recordingStatus.courseData;
-    if (!courseData || !Array.isArray(courseData) || courseData.length === 0) {
-      throw new Error('No course data available for navigation');
-    }
-    
-    // Validate indices
-    if (sectionIndex >= courseData.length) {
-      throw new Error(`Section index ${sectionIndex} out of bounds (total: ${courseData.length})`);
-    }
-    
-    const section = courseData[sectionIndex];
-    if (lectureIndex >= section.lectures.length) {
-      throw new Error(`Lecture index ${lectureIndex} out of bounds (total: ${section.lectures.length})`);
-    }
-    
-    // Get section and lecture info
-    const sectionTitle = section.section;
-    const lectureTitle = section.lectures[lectureIndex].title;
-    const lectureUrl = section.lectures[lectureIndex].url; // URL may be available in some cases
-    
-    console.log(`Navigating to: ${sectionTitle} > ${lectureTitle}`);
-    
-    // Store current URL to detect if navigation actually occurred
-    const initialUrl = window.location.href;
-    console.log('Initial URL:', initialUrl);
-    
-    // Try multiple navigation methods in order of preference
-    
-    // Method 1: Direct URL navigation if available
-    if (lectureUrl && lectureUrl.startsWith('http')) {
-      try {
-        console.log('Attempting direct URL navigation:', lectureUrl);
-        window.location.href = lectureUrl;
-        
-        // Wait for the page to load
-        await new Promise(resolve => setTimeout(resolve, 5000));
-        
-        // Check if URL actually changed
-        if (window.location.href !== initialUrl) {
-          console.log('URL navigation successful');
-          return { sectionTitle, lectureTitle };
-        } else {
-          console.log('URL didn\'t change, trying other methods');
-        }
-      } catch (err) {
-        console.warn('Error in direct URL navigation:', err);
-      }
-    }
-    
-    // Method 2: Try to find the lecture directly in the sidebar
-    try {
-      console.log('Attempting direct lecture navigation...');
-      
-      // Make sure all sections are expanded first
-      const expandButtons = document.querySelectorAll(
-        '[data-purpose="expand-all"], ' + 
-        'button[aria-label="Expand all sections"], ' +
-        'button.ud-btn-ghost[aria-label*="all sections"]'
-      );
-      
-      if (expandButtons && expandButtons.length > 0) {
-        console.log('Clicking "Expand All" button...');
-        expandButtons[0].click();
-        await new Promise(resolve => setTimeout(resolve, 2000));
-      } else {
-        // Try expanding individual sections if expand all is not available
-        const sectionHeaders = document.querySelectorAll(
-          '.ud-accordion-panel-heading, ' +
-          '[data-purpose^="section-panel-"] button, ' +
-          '[data-purpose="curriculum-section-heading"]'
-        );
-        console.log(`Found ${sectionHeaders.length} section headers to expand`);
-        
-        for (const header of sectionHeaders) {
-          const isExpanded = header.getAttribute('aria-expanded') === 'true';
-          if (!isExpanded) {
-            console.log('Expanding section:', header.innerText);
-            header.click();
-            await new Promise(resolve => setTimeout(resolve, 500));
-          }
-        }
-      }
-      
-      // Try to find the exact lecture by title
-      const lectureElements = Array.from(document.querySelectorAll(
-        '[data-purpose^="curriculum-item-"], ' +
-        '.ud-block-list-item, ' +
-        '.curriculum-item-link, ' +
-        'div[class*="item--"], ' +
-        '[data-purpose*="lecture"]'
-      ));
-      
-      console.log(`Found ${lectureElements.length} potential lecture elements`);
-      
-      // Find lecture by exact title match
-      let lectureElement = lectureElements.find(el => {
-        const titleEl = el.querySelector('[data-purpose="item-title"], .ud-block-list-item-content, .item-title');
-        return titleEl && titleEl.innerText.trim() === lectureTitle;
-      });
-      
-      // If exact match fails, try partial match
-      if (!lectureElement) {
-        console.log('Exact title match failed, trying partial match...');
-        lectureElement = lectureElements.find(el => {
-          return el.textContent.includes(lectureTitle);
-        });
-      }
-      
-      // If we found the lecture, click on it
-      if (lectureElement) {
-        console.log('Found lecture by title match, clicking...');
-        
-        const playButton = lectureElement.querySelector('button[aria-label^="Play"], [data-purpose="play-button"], a');
-        if (playButton) {
-          playButton.click();
-          await new Promise(resolve => setTimeout(resolve, 5000));
-          
-          // Verify navigation occurred by checking URL or title
-          if (window.location.href !== initialUrl) {
-            console.log('Navigation successful - URL changed');
-            return { sectionTitle, lectureTitle };
-          }
-          
-          const currentPageTitle = document.querySelector('.ud-heading-xxl[data-purpose="lecture-title"]')?.innerText?.trim();
-          if (currentPageTitle && (currentPageTitle === lectureTitle || lectureTitle.includes(currentPageTitle))) {
-            console.log('Navigation successful - title matches');
-            return { sectionTitle, lectureTitle };
-          }
-          
-          console.log('Navigation might have failed - continuing with other methods');
-        } else {
-          console.log('No play button found, trying to click the lecture element itself');
-          lectureElement.click();
-          await new Promise(resolve => setTimeout(resolve, 5000));
-          
-          // Verify navigation
-          if (window.location.href !== initialUrl) {
-            console.log('Navigation successful - URL changed');
-            return { sectionTitle, lectureTitle };
-          }
-        }
-      }
-      
-      console.log('Could not find lecture by title, trying alternative methods...');
-    } catch (err) {
-      console.warn('Error in direct lecture navigation:', err);
-    }
-    
-    // Method 3: Sequential navigation using next button
-    try {
-      console.log('Attempting sequential navigation...');
-      
-      // First check if we're already on a lecture page
-      const currentUrl = window.location.href;
-      console.log('Current URL:', currentUrl);
-      
-      // Determine if we need to navigate to the course page first
-      if (!currentUrl.includes('/course/') && !currentUrl.includes('/learn/')) {
-        // Try to find a link to the course and click it
-        console.log('Not on a course page, trying to find course link...');
-        return { sectionTitle, lectureTitle };
-      }
-      
-      // If we're on a course landing page, try to find "Start course" or similar buttons
-      if (currentUrl.includes('/course/') && !currentUrl.includes('/learn/') && !currentUrl.includes('/lecture/')) {
-        console.log('On course landing page, looking for start button...');
-        
-        const startButtons = document.querySelectorAll(
-          '[data-purpose="start-course-button"], ' +
-          'a[href*="learn"], ' +
-          'button:contains("Start"), ' +
-          'a:contains("Start course")'
-        );
-        
-        if (startButtons && startButtons.length > 0) {
-          console.log('Found start button, clicking...');
-          startButtons[0].click();
-          await new Promise(resolve => setTimeout(resolve, 5000));
-        }
-      }
-      
-      // Find and click the next button repeatedly until we reach desired lecture
-      // We'll use a combination of section progression and checking lecture titles
-      let navAttempts = 0;
-      const MAX_NAV_ATTEMPTS = 50; // More generous limit
-      let currentSectionText = '';
-      let currentLectureText = '';
-      
-      while (navAttempts < MAX_NAV_ATTEMPTS) {
-        // Get current section and lecture titles
-        currentSectionText = document.querySelector(
-          '.ud-heading-sm[data-purpose="section-title"], ' +
-          '[data-purpose="curriculum-section-title"]'
-        )?.innerText?.trim() || '';
-        
-        currentLectureText = document.querySelector(
-          '.ud-heading-xxl[data-purpose="lecture-title"], ' +
-          '[data-purpose="curriculum-item-title"]'
-        )?.innerText?.trim() || '';
-        
-        console.log(`Current position: Section "${currentSectionText}" > Lecture "${currentLectureText}"`);
-        
-        // Check if we've reached the target
-        const sectionMatches = currentSectionText === sectionTitle || sectionTitle.includes(currentSectionText);
-        const lectureMatches = currentLectureText === lectureTitle || lectureTitle.includes(currentLectureText);
-        
-        if (sectionMatches && lectureMatches) {
-          console.log('Found target lecture!');
-          return { sectionTitle, lectureTitle: currentLectureText || lectureTitle };
-        }
-        
-        // Find next button
-        const nextButton = document.querySelector(
-          '[data-purpose="go-to-next-lesson"], ' +
-          'button[aria-label*="Next"], ' +
-          '[class*="btn--next"], ' +
-          'a[data-purpose="next-lesson"]'
-        );
-        
-        if (!nextButton) {
-          console.warn('No next button found, navigation failed');
-          break;
-        }
-        
-        // Store current URL to detect if navigation actually happens
-        const beforeClickUrl = window.location.href;
-        
-        // Click next
-        console.log(`Sequential navigation attempt ${navAttempts + 1}...`);
-        nextButton.click();
-        
-        // Wait for navigation
-        await new Promise(resolve => setTimeout(resolve, 4000));
-        
-        // Check if URL changed - if not, we might be stuck
-        if (window.location.href === beforeClickUrl) {
-          console.log('URL did not change after clicking next, waiting longer...');
-          await new Promise(resolve => setTimeout(resolve, 3000));
-          
-          // Check again
-          if (window.location.href === beforeClickUrl) {
-            console.warn('Navigation may be stuck, trying alternative method');
-            break;
-          }
-        }
-        
-        navAttempts++;
-      }
-      
-      if (navAttempts >= MAX_NAV_ATTEMPTS) {
-        console.warn('Reached maximum navigation attempts without finding target lecture');
-      }
-      
-      // Return the titles of where we ended up
-      return { 
-        sectionTitle: currentSectionText || sectionTitle, 
-        lectureTitle: currentLectureText || lectureTitle 
-      };
-    } catch (err) {
-      console.warn('Error in sequential navigation:', err);
-    }
-    
-    // If all our methods fail, return the expected titles but log an error
-    console.error('All navigation methods failed, using fallback titles');
-    return { sectionTitle, lectureTitle };
-  } catch (error) {
-    console.error('Error navigating to lecture:', error);
-    throw error;
-  }
-}
-
-// Extract transcript from the current lecture
-async function extractTranscript() {
-  // First, get the current section and lecture titles from the page
-  const sectionTitle = document.querySelector('.ud-heading-sm[data-purpose="section-title"]')?.innerText.trim() 
-    || currentProgress.currentSection 
-    || 'Unknown Section';
-  
-  const lectureTitle = document.querySelector('.ud-heading-xxl[data-purpose="lecture-title"]')?.innerText.trim() 
-    || currentProgress.currentLecture 
-    || 'Unknown Lecture';
-  
-  console.log(`Extracting transcript for: ${sectionTitle} > ${lectureTitle}`);
-  
-  try {
-    // Check if this is a video lecture that might have transcripts
-    const videoPlayer = document.querySelector('video, [data-purpose="video-container"], [data-purpose="video-player"]');
-    if (!videoPlayer) {
-      console.log('No video player found - this may not be a video lecture');
-      return { 
-        sectionTitle, 
-        lectureTitle, 
-        transcript: ['[This lecture does not contain a video with transcript]'] 
-      };
-    }
-    
-    // Check if transcript button exists before trying to open panel
-    const transcriptButtonExists = !!document.querySelector('button[data-purpose="transcript-toggle"]');
-    if (!transcriptButtonExists) {
-      console.log('No transcript button found - this lecture likely has no transcript');
-      return { 
-        sectionTitle, 
-        lectureTitle, 
-        transcript: ['[No transcript available for this lecture]'] 
-      };
-    }
-    
-    // Open the transcript panel if it's not already open
-    try {
-      await openTranscriptPanel();
-    } catch (error) {
-      console.warn('Could not open transcript panel:', error.message);
-      return { 
-        sectionTitle, 
-        lectureTitle, 
-        transcript: [`[Could not open transcript panel: ${error.message}]`] 
-      };
-    }
-    
-    // Wait for transcript content to be available
-    try {
-      await waitForElement('[data-purpose="cue-text"]', 10000);
-    } catch (error) {
-      console.warn('No transcript elements found after opening panel:', error.message);
-      return { 
-        sectionTitle, 
-        lectureTitle, 
-        transcript: ['[No transcript content found]'] 
-      };
-    }
-    
-    // Extract the transcript text
-    const transcriptElements = document.querySelectorAll('[data-purpose="cue-text"]');
-    
-    if (transcriptElements.length === 0) {
-      return { 
-        sectionTitle, 
-        lectureTitle, 
-        transcript: ['[No transcript available for this lecture]'] 
-      };
-    }
-    
-    const transcript = Array.from(transcriptElements).map(el => el.innerText.trim());
-    console.log(`Successfully extracted ${transcript.length} transcript lines`);
-    
-    // Return the transcript data
-    return { sectionTitle, lectureTitle, transcript };
-  } catch (error) {
-    console.error('Error extracting transcript:', error);
-    
-    // If transcript can't be found, return an empty transcript
-    return { 
-      sectionTitle, 
-      lectureTitle, 
-      transcript: [`[Could not extract transcript: ${error.message}]`] 
-    };
-  }
-}
-
-// Open the transcript panel if it's not already open
-async function openTranscriptPanel() {
-  try {
-    const transcriptButton = await waitForElement('button[data-purpose="transcript-toggle"]', 10000);
-    
-    // Check if transcript is already expanded
-    const isExpanded = transcriptButton.getAttribute('aria-expanded') === 'true';
-    
-    if (!isExpanded) {
-      // Click to expand
-      console.log('Expanding transcript panel');
-      transcriptButton.click();
-      
-      // Wait for the panel to open
-      await new Promise(resolve => setTimeout(resolve, 2000));
-      
-      // Double-check that it opened
-      const nowExpanded = transcriptButton.getAttribute('aria-expanded') === 'true';
-      if (!nowExpanded) {
-        console.warn('Transcript panel did not expand after clicking - trying again');
-        transcriptButton.click();
-        await new Promise(resolve => setTimeout(resolve, 2000));
-      }
-    } else {
-      console.log('Transcript panel already expanded');
-    }
-  } catch (error) {
-    // If transcript button isn't found, the video might not have a transcript
-    console.warn('Transcript button not found:', error);
-    throw new Error('No transcript available for this lecture');
-  }
-}
-
-// Helper function to wait for an element to be available in the DOM with exponential backoff
-function waitForElement(selector, timeout = 15000) {
-  return new Promise((resolve, reject) => {
-    const startTime = Date.now();
-    let interval = 100;
-    const maxInterval = 1000;
-    
-    function checkElement() {
-      const element = document.querySelector(selector);
-      
-      if (element) {
-        resolve(element);
-      } else if (Date.now() - startTime > timeout) {
-        reject(new Error(`Timed out waiting for element: ${selector}`));
-      } else {
-        // Exponential backoff
-        interval = Math.min(interval * 1.5, maxInterval);
-        setTimeout(checkElement, interval);
-      }
-    }
-    
-    checkElement();
-  });
-}
 
 // Create a progress panel
 function createProgressPanel() {
@@ -628,41 +350,4 @@
   // Update UI to show we're trying to move forward
   updateProgressPanel(`Error recorded. Attempting to continue...`);
 } 
-</file>
-<file path="manifest.json">
-{
-  "manifest_version": 3,
-  "name": "Udemy Full Transcript Extractor for LLMs",
-  "version": "1.0",
-  "description": "Enhance your learning experience by using the transcripts with popular AI tools like NoteLLM, ChatGPT, Gemini, Claude, and more.",
-  "permissions": ["storage", "tabs"],
-  "host_permissions": ["https://*.udemy.com/*"],
-  "background": {
-    "service_worker": "background.js"
-  },
-  "content_scripts": [
-    {
-      "matches": ["https://*.udemy.com/course/*"],
-      "js": ["content.js"]
-    }
-  ],
-  "action": {
-    "default_popup": "popup.html",
-    "default_icon": {
-      "16": "icons/icon16.png",
-      "48": "icons/icon48.png",
-      "128": "icons/icon128.png"
-    }
-  },
-  "icons": {
-    "16": "icons/icon16.png",
-    "48": "icons/icon48.png",
-    "128": "icons/icon128.png"
-  }
-} 
-</file>
-<file path="popup.html">
-<!DOCTYPE html>
-<html>
-<head>
-  <title>Udemy Transcript Extractor</title>
-  <style>
-    body {
-      font-family: Arial, sans-serif;
-      width: 350px;
-      padding: 20px;
-      margin: 0;
-    }
-    h1 {
-      color: #a435f0;
-      text-align: center;
-      margin-top: 0;
-      margin-bottom: 20px;
-      font-size: 20px;
-    }
-    button {
-      background-color: #a435f0;
-      color: white;
-      border: none;
-      padding: 10px 15px;
-      cursor: pointer;
-      width: 100%;
-      margin-bottom: 10px;
-      border-radius: 4px;
-      transition: background-color 0.3s;
-    }
-    button:hover {
-      background-color: #8710d8;
-    }
-    .hidden {
-      display: none;
-    }
-    #stop-recording {
-      background-color: #e53935;
-    }
-    #stop-recording:hover {
-      background-color: #c62828;
-    }
-    #clear-transcripts {
-      background-color: #757575;
-    }
-    #clear-transcripts:hover {
-      background-color: #616161;
-    }
-    #confirmation-dialog {
-      background-color: #f5f5f5;
-      padding: 15px;
-      border-radius: 4px;
-      margin-bottom: 15px;
-    }
-    #confirmation-dialog p {
-      margin-top: 0;
-    }
-    .confirm-buttons {
-      display: flex;
-      gap: 10px;
-    }
-    .confirm-buttons button {
-      flex: 1;
-    }
-    #confirm-yes {
-      background-color: #4caf50;
-    }
-    #confirm-yes:hover {
-      background-color: #388e3c;
-    }
-    #confirm-no {
-      background-color: #f44336;
-    }
-    #confirm-no:hover {
-      background-color: #d32f2f;
-    }
-    #status {
-      margin-bottom: 15px;
-      padding: 10px;
-      border-radius: 4px;
-      text-align: center;
-    }
-    .error {
-      background-color: #ffebee;
-      color: #c62828;
-      border: 1px solid #ef9a9a;
-    }
-    .success {
-      background-color: #e8f5e9;
-      color: #2e7d32;
-      border: 1px solid #a5d6a7;
-    }
-    .info {
-      background-color: #e3f2fd;
-      color: #1565c0;
-      border: 1px solid #90caf9;
-    }
-    .loading {
-      display: inline-block;
-      width: 15px;
-      height: 15px;
-      border: 2px solid rgba(0, 0, 0, 0.1);
-      border-radius: 50%;
-      border-top-color: #a435f0;
-      animation: spin 1s ease-in-out infinite;
-      margin-right: 8px;
-      vertical-align: middle;
-    }
-    @keyframes spin {
-      to { transform: rotate(360deg); }
-    }
-    .version {
-      text-align: center;
-      font-size: 10px;
-      color: #757575;
-      margin-top: 15px;
-    }
-    .debug-info {
-      background-color: #f5f5f5;
-      padding: 10px;
-      border-radius: 4px;
-      margin-top: 15px;
-      font-size: 12px;
-      color: #757575;
-    }
-  </style>
-  <script src="popup.js"></script>
-</head>
-<body>
-  <h1>Udemy Transcript Extractor</h1>
-  
-  <!-- Status Message -->
-  <div id="status" class="hidden"></div>
-  
-  <!-- Confirmation Dialog -->
-  <div id="confirmation-dialog" class="hidden">
-    <p>This will extract transcripts from all videos in the course. The process will:</p>
-    <ol>
-      <li>Navigate through each video in the course</li>
-      <li>Extract transcript text from each video</li>
-      <li>Save all transcripts for downloading later</li>
-    </ol>
-    <p>During recording, please <strong>don't interact with the Udemy page</strong> until the process is complete.</p>
-    <div class="confirm-buttons">
-      <button id="confirm-yes">Start Recording</button>
-      <button id="confirm-no">Cancel</button>
-    </div>
-  </div>
-  
-  <!-- Main Controls -->
-  <div id="main-controls">
-    <button id="start-recording">Record Course Transcripts</button>
-    <button id="stop-recording" class="hidden">Stop Recording</button>
-    <button id="download-transcripts" class="hidden">Download Transcripts</button>
-    <button id="clear-transcripts" class="hidden">Clear Transcripts</button>
-  </div>
-  
-  <!-- Debug Info (hidden by default) -->
-  <div id="debug-info" class="debug-info hidden">
-    <div id="debug-content"></div>
-  </div>
-  
-  <div class="version"><a href="https://www.mypromind.com" target="_blank">Brought to you by MyProMind.com</a></div>
-</body>
-</html> 
-</file>
-<file path="popup.js">
-document.addEventListener('DOMContentLoaded', function() {
-  const startRecordingBtn = document.getElementById('start-recording');
-  const stopRecordingBtn = document.getElementById('stop-recording');
-  const downloadTranscriptsBtn = document.getElementById('download-transcripts');
-  const clearTranscriptsBtn = document.getElementById('clear-transcripts');
-  const confirmationDialog = document.getElementById('confirmation-dialog');
-  const confirmYesBtn = document.getElementById('confirm-yes');
-  const confirmNoBtn = document.getElementById('confirm-no');
-  const mainControls = document.getElementById('main-controls');
-  const statusDiv = document.getElementById('status');
-  
-  // Initialize the extension popup
-  initializePopup();
-
-  function initializePopup() {
-    // Show loading status initially
-    showStatus('Checking extension status...', 'info');
-    
-    // Check if there's a recording in progress and saved transcript data
-    chrome.runtime.sendMessage({action: 'getRecordingStatus'}, function(response) {
-      // Check for chrome runtime error (extension restarted, etc.)
-      if (chrome.runtime.lastError) {
-        console.error('Chrome runtime error:', chrome.runtime.lastError);
-        showStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
-        mainControls.classList.remove('hidden');
-        return;
-      }
-      
-      if (response && response.isRecording) {
-        startRecordingBtn.classList.add('hidden');
-        stopRecordingBtn.classList.remove('hidden');
-        
-        // Show current recording status
-        const sectionIndex = response.currentSectionIndex + 1;
-        const lectureIndex = response.currentLectureIndex + 1;
-        showStatus(`Recording in progress (Section ${sectionIndex}, Lecture ${lectureIndex})`, 'info');
-        
-        // Start health check if recording is in progress
-        startHealthCheck();
-      } else {
-        startRecordingBtn.classList.remove('hidden');
-        stopRecordingBtn.classList.add('hidden');
-        
-        // If there was a last error, show it
-        if (response && response.lastError) {
-          showStatus(`Last error: ${response.lastError}`, 'error');
-        } else {
-          // Hide status message if no issues
-          statusDiv.classList.add('hidden');
-        }
-      }
-      
-      // Always show main controls after checking status
-      mainControls.classList.remove('hidden');
-      
-      // Check for transcript data
-      checkForTranscriptData();
-    });
-  }
-
-  function checkForTranscriptData() {
-    chrome.storage.local.get(['transcriptData'], function(result) {
-      if (chrome.runtime.lastError) {
-        console.error('Error accessing storage:', chrome.runtime.lastError);
-        return;
-      }
-      
-      if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
-        downloadTranscriptsBtn.classList.remove('hidden');
-        clearTranscriptsBtn.classList.remove('hidden');
-        
-        // Debug info
-        let sectionCount = Object.keys(result.transcriptData).length;
-        let lectureCount = 0;
-        for (const section in result.transcriptData) {
-          lectureCount += Object.keys(result.transcriptData[section]).length;
-        }
-        console.log(`Found ${sectionCount} sections with ${lectureCount} lectures in storage`);
-      } else {
-        downloadTranscriptsBtn.classList.add('hidden');
-        clearTranscriptsBtn.classList.add('hidden');
-      }
-    });
-  }
-
-  // Start recording button clicked
-  startRecordingBtn.addEventListener('click', function() {
-    // First check if we're on a valid Udemy page
-    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
-      if (!tabs || !tabs[0]) {
-        showStatus('Cannot access current tab information', 'error');
-        return;
-      }
-      
-      const currentUrl = tabs[0].url;
-      if (!currentUrl.includes('udemy.com/course') && !currentUrl.includes('udemy.com/learn')) {
-        showStatus('Please navigate to a Udemy course page first', 'error');
-        return;
-      }
-      
-      // Show confirmation dialog
-      mainControls.classList.add('hidden');
-      confirmationDialog.classList.remove('hidden');
-    });
-  });
-
-  // Stop recording button clicked
-  stopRecordingBtn.addEventListener('click', function() {
-    showStatus('Stopping recording...', 'info');
-    chrome.runtime.sendMessage({action: 'stopRecording'}, function(response) {
-      if (chrome.runtime.lastError) {
-        showStatus('Error stopping recording: ' + chrome.runtime.lastError.message, 'error');
-        return;
-      }
-      
-      if (response && response.success) {
-        showStatus('Recording stopped successfully', 'success');
-        startRecordingBtn.classList.remove('hidden');
-        stopRecordingBtn.classList.add('hidden');
-        checkForTranscriptData();
-      } else {
-        showStatus('Failed to stop recording', 'error');
-      }
-    });
-  });
-
-  // Confirm recording
-  confirmYesBtn.addEventListener('click', function() {
-    confirmationDialog.classList.add('hidden');
-    startRecording();
-  });
-
-  // Cancel recording
-  confirmNoBtn.addEventListener('click', function() {
-    confirmationDialog.classList.add('hidden');
-    mainControls.classList.remove('hidden');
-  });
-
-  // Download transcripts
-  downloadTranscriptsBtn.addEventListener('click', function() {
-    showStatus('Preparing transcript download...', 'info');
-    chrome.storage.local.get(['transcriptData'], function(result) {
-      if (chrome.runtime.lastError) {
-        showStatus('Error accessing storage: ' + chrome.runtime.lastError.message, 'error');
-        return;
-      }
-      
-      if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
-        const transcriptText = formatTranscriptData(result.transcriptData);
-        downloadAsFile(transcriptText, 'udemy_transcript.txt');
-        showStatus('Download started!', 'success');
-        
-        // Clear status after 3 seconds
-        setTimeout(() => {
-          statusDiv.classList.add('hidden');
-        }, 3000);
-      } else {
-        showStatus('No transcript data found', 'error');
-      }
-    });
-  });
-
-  // Clear transcripts
-  clearTranscriptsBtn.addEventListener('click', function() {
-    if (confirm('Are you sure you want to clear all transcript data? This cannot be undone.')) {
-      showStatus('Clearing transcript data...', 'info');
-      chrome.runtime.sendMessage({action: 'clearTranscriptData'}, function(response) {
-        if (chrome.runtime.lastError) {
-          showStatus('Error clearing data: ' + chrome.runtime.lastError.message, 'error');
-          return;
-        }
-        
-        if (response && response.success) {
-          showStatus('Transcript data cleared successfully', 'success');
-          downloadTranscriptsBtn.classList.add('hidden');
-          clearTranscriptsBtn.classList.add('hidden');
-        } else {
-          showStatus('Failed to clear transcript data', 'error');
-        }
-      });
-    }
-  });
-
-  // Health check to monitor recording progress
-  let healthCheckInterval = null;
-  let lastSection = -1;
-  let lastLecture = -1;
-  let stuckCounter = 0;
-
-  function startHealthCheck() {
-    // Clear any existing interval
-    if (healthCheckInterval) {
-      clearInterval(healthCheckInterval);
-    }
-    
-    // Initialize the last known position
-    chrome.runtime.sendMessage({action: 'getRecordingStatus'}, function(response) {
-      if (response && response.isRecording) {
-        lastSection = response.currentSectionIndex;
-        lastLecture = response.currentLectureIndex;
-        console.log(`Health check initialized at Section ${lastSection + 1}, Lecture ${lastLecture + 1}`);
-      }
-    });
-    
-    // Start periodic health check
-    healthCheckInterval = setInterval(() => {
-      chrome.runtime.sendMessage({action: 'getRecordingStatus'}, function(response) {
-        if (!response || !response.isRecording) {
-          // Recording has stopped, clear interval
-          clearInterval(healthCheckInterval);
-          healthCheckInterval = null;
-          return;
-        }
-        
-        // Check if we've moved since last check
-        if (response.currentSectionIndex === lastSection && 
-            response.currentLectureIndex === lastLecture) {
-          stuckCounter++;
-          console.log(`Possible stuck recording detected. Counter: ${stuckCounter}`);
-          
-          // If stuck for too long (3 checks), try to recover
-          if (stuckCounter >= 3) {
-            console.log('Recording appears stuck, attempting recovery');
-            attemptRecovery();
-          }
-        } else {
-          // Progress has been made, reset counter
-          stuckCounter = 0;
-          lastSection = response.currentSectionIndex;
-          lastLecture = response.currentLectureIndex;
-          console.log(`Recording progressing normally. Now at Section ${lastSection + 1}, Lecture ${lastLecture + 1}`);
-        }
-      });
-    }, 60000); // Check every minute
-  }
-
-  function attemptRecovery() {
-    // First check if content script is responsive
-    chrome.runtime.sendMessage({action: 'checkRecordingHealth'}, function(response) {
-      if (!response || !response.healthy) {
-        console.log('Health check failed, forcing next lecture');
-        
-        // Force moving to next lecture as recovery measure
-        chrome.runtime.sendMessage({action: 'forceNextLecture'}, function(result) {
-          if (result && result.success) {
-            console.log('Recovery attempt successful, forcing next lecture');
-            updateDebugInfo('Recovery: Forced moving to next lecture after stuck detection');
-            stuckCounter = 0;
-          } else if (result && result.stopped) {
-            console.log('Recording stopped due to too many errors');
-            updateDebugInfo('Recording stopped due to too many errors during recovery');
-            clearInterval(healthCheckInterval);
-            healthCheckInterval = null;
-          } else {
-            console.log('Recovery attempt failed');
-            updateDebugInfo('Recovery attempt failed');
-          }
-        });
-      } else {
-        console.log('Content script is responsive but recording appears stuck');
-        updateDebugInfo('Content script responsive but recording appears stuck');
-      }
-    });
-  }
-
-  function updateDebugInfo(message) {
-    const debugInfo = document.getElementById('debug-info');
-    const debugContent = document.getElementById('debug-content');
-    
-    if (debugInfo && debugContent) {
-      const timestamp = new Date().toLocaleTimeString();
-      const entry = document.createElement('div');
-      entry.textContent = `${timestamp}: ${message}`;
-      debugContent.appendChild(entry);
-      debugInfo.classList.remove('hidden');
-      
-      // Limit to last 5 entries
-      while (debugContent.children.length > 5) {
-        debugContent.removeChild(debugContent.firstChild);
-      }
-    }
-  }
-
-  function startRecording() {
-    // Send message to the background script to start recording
-    showStatus('Starting recording process...', 'info');
-    
-    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
-      if (!tabs || !tabs[0]) {
-        showStatus('Cannot access current tab information', 'error');
-        mainControls.classList.remove('hidden');
-        return;
-      }
-      
-      const currentUrl = tabs[0].url;
-      if (!currentUrl.includes('udemy.com/course') && !currentUrl.includes('udemy.com/learn')) {
-        showStatus('Please navigate to a Udemy course page first', 'error');
-        mainControls.classList.remove('hidden');
-        return;
-      }
-      
-      chrome.runtime.sendMessage({action: 'startRecording', courseTab: tabs[0].id}, function(response) {
-        if (chrome.runtime.lastError) {
-          showStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
-          mainControls.classList.remove('hidden');
-          return;
-        }
-        
-        if (response && response.success) {
-          showStatus('Recording started! You can close this popup.', 'success');
-          
-          // Update UI
-          startRecordingBtn.classList.add('hidden');
-          stopRecordingBtn.classList.remove('hidden');
-          
-          // Start health check
-          startHealthCheck();
-          
-          // Clear after 3 seconds and show main controls
-          setTimeout(() => {
-            statusDiv.classList.add('hidden');
-            mainControls.classList.remove('hidden');
-          }, 3000);
-        } else {
-          const errorMsg = response && response.error 
-            ? `Failed to start recording: ${response.error}` 
-            // Otherwise alphabetical
-            return a.localeCompare(b);
-        });
-    }
-
-    function downloadAsFile(content, filename) {
-        const blob = new Blob([content], {
-            type: 'text/plain'
-        });
-        const url = URL.createObjectURL(blob);
-        const a = document.createElement('a');
-        a.href = url;
-        a.download = filename;
-        document.body.appendChild(a);
-        a.click();
-        document.body.removeChild(a);
-        URL.revokeObjectURL(url);
-    }
-});
\ No newline at end of file
```