// Pure functions extracted from background.js and popup.js for testability.

// Pick the best caption from a Udemy lecture's captions array based on user
// preference. Returns the matched caption object (with `.url`, `.locale_id`,
// etc.) or null if no acceptable match exists.
//
//   - preferredLocale falsy or 'auto' → English first (en_US, en_GB, en_*),
//     else first available caption. Always returns something if captions exist.
//   - preferredLocale set (e.g. 'es_ES') → exact match, then language-prefix
//     match (e.g. 'pt_BR' falls back to 'pt_PT'), then null. We do not silently
//     fall back across languages — the caller surfaces a clearer error.
function pickCaption(captions, preferredLocale) {
    if (!captions || captions.length === 0) return null;
    const valid = captions.filter(c => c && typeof c.locale_id === 'string');
    if (valid.length === 0) return null;

    if (!preferredLocale || preferredLocale === 'auto') {
        return valid.find(c => c.locale_id === 'en_US')
            || valid.find(c => c.locale_id === 'en_GB')
            || valid.find(c => c.locale_id.startsWith('en'))
            || valid[0];
    }

    const exact = valid.find(c => c.locale_id === preferredLocale);
    if (exact) return exact;

    const lang = preferredLocale.split('_')[0];
    return valid.find(c => c.locale_id.split('_')[0] === lang) || null;
}

// VTT parsing helper (from background.js)
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

// Parse flat curriculum API results into structured courseData (from background.js)
function parseCurriculum(results) {
    const courseData = { sections: [], lectures: [] };
    let currentSection = { section: 'Course Introduction', sectionIndex: 0, lectures: [] };
    let sectionIndex = 0;
    let globalLectureIndex = 0;

    results.sort((a, b) => a.object_index - b.object_index); // Ensure correct order

    for (const item of results) {
        if (item._class === 'chapter') {
            // Save the previous section if it has lectures
            if (currentSection.lectures.length > 0) {
                courseData.sections.push(currentSection);
            }
            sectionIndex++;
            currentSection = { section: item.title, sectionIndex: sectionIndex, lectures: [] };
        } else if (item._class === 'lecture') {
            const lectureInfo = {
                id: item.id,
                title: item.title,
                section: currentSection.section,
                sectionIndex: currentSection.sectionIndex,
                lectureIndex: globalLectureIndex
            };
            globalLectureIndex++;
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

// Helper to sort sections using stored sectionIndex (from popup.js)
function sortSections(sections, data) {
    return [...sections].sort((a, b) => {
        // Get the sectionIndex from the first lecture in each section
        const aLectures = Object.values(data[a] || {});
        const bLectures = Object.values(data[b] || {});

        // Extract sectionIndex from the first lecture (if available)
        const aIndex = aLectures.length > 0 && aLectures[0].sectionIndex !== undefined
            ? aLectures[0].sectionIndex : null;
        const bIndex = bLectures.length > 0 && bLectures[0].sectionIndex !== undefined
            ? bLectures[0].sectionIndex : null;

        // If both have stored indices, use them
        if (aIndex !== null && bIndex !== null) {
            return aIndex - bIndex;
        }

        // Fallback to name-based sorting for backward compatibility
        const aMatch = a.match(/^(\d+)[.\s:)-]+/);
        const bMatch = b.match(/^(\d+)[.\s:)-]+/);

        if (aMatch && bMatch) {
            return parseInt(aMatch[1]) - parseInt(bMatch[1]);
        }
        if (aMatch) return -1;
        if (bMatch) return 1;

        return a.localeCompare(b);
    });
}

// Helper to sort lectures using stored lectureIndex (from popup.js)
function sortLectures(lectures, sectionData) {
    return [...lectures].sort((a, b) => {
        // Get the lectureIndex from stored data (if available)
        const aData = sectionData[a];
        const bData = sectionData[b];

        const aIndex = aData && aData.lectureIndex !== undefined ? aData.lectureIndex : null;
        const bIndex = bData && bData.lectureIndex !== undefined ? bData.lectureIndex : null;

        // If both have stored indices, use them
        if (aIndex !== null && bIndex !== null) {
            return aIndex - bIndex;
        }

        // Fallback to name-based sorting for backward compatibility
        const aMatch = a.match(/^(\d+)[.\s:)-]+/);
        const bMatch = b.match(/^(\d+)[.\s:)-]+/);

        if (aMatch && bMatch) {
            return parseInt(aMatch[1]) - parseInt(bMatch[1]);
        }
        if (aMatch) return -1;
        if (bMatch) return 1;

        return a.localeCompare(b);
    });
}

// Helper to get transcript from lecture data (handles both old and new format) (from popup.js)
function getTranscript(lectureData) {
    // New format: { sectionIndex, lectureIndex, transcript }
    if (lectureData && lectureData.transcript !== undefined) {
        return lectureData.transcript;
    }
    // Old format: transcript is the array directly
    return lectureData;
}

// Helper to create an anchor from text (from popup.js)
function createAnchor(text) {
    return text.toLowerCase()
        .replace(/\s+/g, '-')       // Replace spaces with hyphens
        .replace(/[^\w-]/g, '')     // Remove non-word chars
        .replace(/--+/g, '-')       // Replace multiple hyphens with single hyphen
        .substring(0, 50);          // Limit length
}

// Format transcript data to text (from popup.js, with courseTitle as parameter)
function formatTranscriptData(data, courseTitle) {
    let text = '';

    courseTitle = courseTitle || 'Udemy Course Transcript';

    // Add course title
    text += `# ${courseTitle}\n\n`;

    // Add timestamp
    const now = new Date();
    text += `*Transcript extracted on ${now.toLocaleDateString()} at ${now.toLocaleTimeString()}*\n\n`;

    // Calculate transcript stats
    let totalSections = 0;
    let totalLectures = 0;
    let totalLines = 0;

    for (const section in data) {
        totalSections++;
        for (const lecture in data[section]) {
            totalLectures++;
            const transcript = getTranscript(data[section][lecture]);
            totalLines += transcript ? transcript.length : 0;
        }
    }

    // Add table of contents
    text += '## Table of Contents\n\n';

    // Get sorted section list using stored indices
    const sectionNames = Object.keys(data);
    const orderedSections = sortSections(sectionNames, data);

    for (const section of orderedSections) {
        if (!data[section]) continue;

        text += `- [${section}](#${createAnchor(section)})\n`;

        const lectures = Object.keys(data[section]);
        const sortedLectures = sortLectures(lectures, data[section]);

        for (const lecture of sortedLectures) {
            text += `  - [${lecture}](#${createAnchor(lecture)})\n`;
        }
    }

    text += '\n---\n\n';

    // Add content
    for (const section of orderedSections) {
        if (!data[section]) continue;

        text += `## ${section} {#${createAnchor(section)}}\n\n`;

        const lectures = Object.keys(data[section]);
        const sortedLectures = sortLectures(lectures, data[section]);

        for (const lecture of sortedLectures) {
            text += `### ${lecture} {#${createAnchor(lecture)}}\n\n`;

            const transcript = getTranscript(data[section][lecture]);
            if (!transcript || transcript.length === 0) {
                text += '*No transcript available for this lecture.*\n\n';
                continue;
            }

            const isError = transcript.length === 1 &&
                (transcript[0].includes('[Error') ||
                    transcript[0].includes('[Could not') ||
                    transcript[0].includes('[No transcript'));

            if (isError) {
                text += `*${transcript[0]}*\n\n`;
            } else {
                text += '```\n';
                transcript.forEach((line) => {
                    text += line + '\n';
                });
                text += '```\n\n';
            }
        }

        text += '\n';
    }

    return text;
}

// Dual-environment export for Node.js (tests) and browser (extension)
if (typeof module !== 'undefined') {
    module.exports = { parseVtt, parseCurriculum, sortSections, sortLectures, getTranscript, createAnchor, formatTranscriptData, pickCaption };
}
