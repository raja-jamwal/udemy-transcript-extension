const path = require('path');
const fs = require('fs');
const { parseVtt, parseCurriculum, sortSections, sortLectures, getTranscript, createAnchor, formatTranscriptData } = require('../lib');

// ---------------------------------------------------------------------------
// Fixtures — each entry: [label, filename, expected counts]
// ---------------------------------------------------------------------------
const FIXTURES = [
  {
    label: 'course 673654',
    file: 'api_recording_673654.json',
    referenceFile: 'udemy_transcript_673654.txt',
    sections: 18,
    lectures: 144,
    withTranscript: 119,
    withoutTranscript: 25,
    firstSection: 'Before Starting the Course',
    lastSection: 'Bonus Section',
    noTranscriptIds: [4765470, 4783346, 4862638, 4893374, 4893794, 4895908, 4896620, 4897300, 4921524, 4927482, 4936744, 4937300, 4943450, 4943512, 4943514, 4943516, 4943518, 4943520, 4943524, 5210906, 5219348, 5744820, 6989152, 7981240, 11422628],
  },
];

// Helper: replay processLectures logic from a fixture
function replayFixture(fixture) {
  const curriculumReq = fixture.requests.find(r => r.type === 'curriculum');
  const courseData = parseCurriculum(curriculumReq.response.results);

  const captionsByLecture = {};
  const vttByLecture = {};
  for (const req of fixture.requests) {
    if (req.type === 'captions') {
      captionsByLecture[req.lectureId] = req.response;
    } else if (req.type === 'vtt') {
      vttByLecture[req.lectureId] = req.response;
    }
  }

  const transcriptData = {};
  for (const lecture of courseData.lectures) {
    const { section, title, sectionIndex, lectureIndex, id } = lecture;
    const captionData = captionsByLecture[id];
    let transcript;

    if (!captionData) {
      transcript = ['[No transcript available for this lecture]'];
    } else {
      const captions = captionData.asset && captionData.asset.captions ? captionData.asset.captions : [];
      if (!captions || captions.length === 0) {
        transcript = ['[No transcript available for this lecture]'];
      } else {
        const englishCaption = captions.find(c => c.locale_id === 'en_US')
          || captions.find(c => c.locale_id === 'en_GB')
          || captions.find(c => c.locale_id && c.locale_id.startsWith('en'));
        if (!englishCaption) {
          transcript = ['[No English transcript found for this lecture]'];
        } else {
          const vttContent = vttByLecture[id];
          transcript = vttContent ? parseVtt(vttContent) : ['[No transcript available for this lecture]'];
        }
      }
    }

    if (!transcriptData[section]) transcriptData[section] = {};
    transcriptData[section][title] = { sectionIndex, lectureIndex, transcript };
  }

  return { courseData, transcriptData };
}

// ---------------------------------------------------------------------------
// parseVtt (unit tests — fixture-independent)
// ---------------------------------------------------------------------------
describe('parseVtt', () => {
  test('strips WEBVTT header, timestamps, and blank lines', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      'Hello world',
      '',
      '00:00:04.000 --> 00:00:06.000',
      'Goodbye world',
    ].join('\n');

    expect(parseVtt(vtt)).toEqual(['Hello world', 'Goodbye world']);
  });

  test('deduplicates consecutive identical lines', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Same line',
      '',
      '00:00:02.000 --> 00:00:03.000',
      'Same line',
      '',
      '00:00:03.000 --> 00:00:04.000',
      'Different line',
    ].join('\n');

    expect(parseVtt(vtt)).toEqual(['Same line', 'Different line']);
  });

  test('strips cue identifiers like <v Speaker>', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '<v Roger>Hello there</v>',
    ].join('\n');

    expect(parseVtt(vtt)).toEqual(['Hello there']);
  });
});

// ---------------------------------------------------------------------------
// sortSections / sortLectures (unit tests — fixture-independent)
// ---------------------------------------------------------------------------
describe('sortSections / sortLectures', () => {
  test('sortSections uses stored sectionIndex, not alphabetical', () => {
    const data = {
      'Zebra Section': { 'Lec A': { sectionIndex: 1, lectureIndex: 0, transcript: [] } },
      'Alpha Section': { 'Lec B': { sectionIndex: 2, lectureIndex: 1, transcript: [] } },
    };
    expect(sortSections(Object.keys(data), data)).toEqual(['Zebra Section', 'Alpha Section']);
  });

  test('sortLectures uses stored lectureIndex, not alphabetical', () => {
    const sectionData = {
      'Zebra Lecture': { sectionIndex: 1, lectureIndex: 5, transcript: [] },
      'Alpha Lecture': { sectionIndex: 1, lectureIndex: 2, transcript: [] },
    };
    expect(sortLectures(Object.keys(sectionData), sectionData)).toEqual(['Alpha Lecture', 'Zebra Lecture']);
  });

  test('sortSections falls back to number prefix when no sectionIndex', () => {
    const data = {
      '2. Second': ['transcript'],
      '1. First': ['transcript'],
    };
    expect(sortSections(Object.keys(data), data)).toEqual(['1. First', '2. Second']);
  });
});

// ---------------------------------------------------------------------------
// getTranscript (unit tests)
// ---------------------------------------------------------------------------
describe('getTranscript', () => {
  test('returns transcript from new format', () => {
    expect(getTranscript({ sectionIndex: 0, lectureIndex: 0, transcript: ['line1', 'line2'] })).toEqual(['line1', 'line2']);
  });

  test('returns array directly from old format', () => {
    expect(getTranscript(['line1', 'line2'])).toEqual(['line1', 'line2']);
  });
});

// ---------------------------------------------------------------------------
// createAnchor (unit tests)
// ---------------------------------------------------------------------------
describe('createAnchor', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    expect(createAnchor('Hello World')).toBe('hello-world');
  });

  test('removes special characters', () => {
    expect(createAnchor('Rethink & Reimagine Leadership')).toBe('rethink-reimagine-leadership');
  });

  test('limits length to 50 characters', () => {
    expect(createAnchor('A'.repeat(100)).length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Per-fixture tests (parameterized across all recordings)
// ---------------------------------------------------------------------------
describe.each(FIXTURES)('$label', (cfg) => {
  let fixture, courseData, transcriptData;

  beforeAll(() => {
    const filePath = path.join(__dirname, 'fixtures', cfg.file);
    fixture = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const result = replayFixture(fixture);
    courseData = result.courseData;
    transcriptData = result.transcriptData;
  });

  // -- parseVtt on real data --
  test('parseVtt produces clean lines from a real VTT', () => {
    const vttEntry = fixture.requests.find(r => r.type === 'vtt');
    expect(vttEntry).toBeDefined();
    const result = parseVtt(vttEntry.response);
    expect(result.length).toBeGreaterThan(0);
    for (const line of result) {
      expect(line).not.toMatch(/^WEBVTT/);
      expect(line).not.toContain('-->');
      expect(line.trim()).not.toBe('');
    }
  });

  // -- parseCurriculum --
  test(`returns ${cfg.sections} sections`, () => {
    expect(courseData.sections.length).toBe(cfg.sections);
  });

  test(`returns ${cfg.lectures} lectures total`, () => {
    expect(courseData.lectures.length).toBe(cfg.lectures);
  });

  test(`first section is "${cfg.firstSection}"`, () => {
    expect(courseData.sections[0].section).toBe(cfg.firstSection);
  });

  test(`last section is "${cfg.lastSection}"`, () => {
    expect(courseData.sections[courseData.sections.length - 1].section).toBe(cfg.lastSection);
  });

  test('sections are ordered by sectionIndex', () => {
    for (let i = 1; i < courseData.sections.length; i++) {
      expect(courseData.sections[i].sectionIndex).toBeGreaterThan(courseData.sections[i - 1].sectionIndex);
    }
  });

  test('each lecture has correct sectionIndex matching its parent section', () => {
    for (const section of courseData.sections) {
      for (const lecture of section.lectures) {
        expect(lecture.sectionIndex).toBe(section.sectionIndex);
        expect(lecture.section).toBe(section.section);
      }
    }
  });

  test('lectures have sequential lectureIndex values', () => {
    for (let i = 0; i < courseData.lectures.length; i++) {
      expect(courseData.lectures[i].lectureIndex).toBe(i);
    }
  });

  // -- Full replay --
  test(`all ${cfg.sections} sections present in transcriptData`, () => {
    expect(Object.keys(transcriptData).length).toBe(cfg.sections);
  });

  test(`${cfg.lectures} lectures total across all sections`, () => {
    let count = 0;
    for (const section in transcriptData) {
      count += Object.keys(transcriptData[section]).length;
    }
    expect(count).toBe(cfg.lectures);
  });

  test('sections are ordered correctly by sectionIndex', () => {
    const sorted = sortSections(Object.keys(transcriptData), transcriptData);
    const indices = sorted.map(name => Object.values(transcriptData[name])[0].sectionIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  test('lectures within each section are ordered correctly by lectureIndex', () => {
    for (const section in transcriptData) {
      const sorted = sortLectures(Object.keys(transcriptData[section]), transcriptData[section]);
      const indices = sorted.map(name => transcriptData[section][name].lectureIndex);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
    }
  });

  test(`${cfg.withTranscript} lectures with transcripts, ${cfg.withoutTranscript} without`, () => {
    let withT = 0, withoutT = 0;
    for (const section in transcriptData) {
      for (const lecture in transcriptData[section]) {
        const t = transcriptData[section][lecture].transcript;
        if (t.length === 1 && (t[0].includes('[No transcript') || t[0].includes('[No English'))) {
          withoutT++;
        } else {
          withT++;
        }
      }
    }
    expect(withT).toBe(cfg.withTranscript);
    expect(withoutT).toBe(cfg.withoutTranscript);
  });

  test('correct lecture IDs have no-transcript markers', () => {
    const noTranscriptIds = [];
    for (const lecture of courseData.lectures) {
      const data = transcriptData[lecture.section][lecture.title];
      const t = data.transcript;
      if (t.length === 1 && (t[0].includes('[No transcript') || t[0].includes('[No English'))) {
        noTranscriptIds.push(lecture.id);
      }
    }
    expect(noTranscriptIds.sort((a, b) => a - b)).toEqual(cfg.noTranscriptIds);
  });

  // -- Verify current code produces correct order --
  describe('current code produces correct order', () => {
    test('formatTranscriptData sections match curriculum order', () => {
      const output = formatTranscriptData(transcriptData, 'Test Course');
      const expectedOrder = courseData.sections.map(s => s.section);

      let lastPos = -1;
      for (const section of expectedOrder) {
        const pos = output.indexOf(`## ${section} {#`);
        expect(pos).toBeGreaterThan(lastPos);
        lastPos = pos;
      }
    });

    test('formatTranscriptData lectures match curriculum order within sections', () => {
      const output = formatTranscriptData(transcriptData, 'Test Course');

      for (const section of courseData.sections) {
        let lastPos = -1;
        for (const lecture of section.lectures) {
          const pos = output.indexOf(`### ${lecture.title} {#`);
          expect(pos).toBeGreaterThan(lastPos);
          lastPos = pos;
        }
      }
    });

    test('output contains only sections from this course (no cross-course contamination)', () => {
      const output = formatTranscriptData(transcriptData, 'Test Course');
      const sectionHeaders = [...output.matchAll(/^## (.+?) \{#/gm)].map(m => m[1]);
      const expectedSections = courseData.sections.map(s => s.section);
      expect(sectionHeaders).toEqual(expectedSections);
    });
  });

});

// ---------------------------------------------------------------------------
// formatTranscriptData (unit tests — fixture-independent)
// ---------------------------------------------------------------------------
describe('formatTranscriptData', () => {
  test('uses provided course title', () => {
    const data = { 'Sec': { 'Lec': { sectionIndex: 0, lectureIndex: 0, transcript: ['hi'] } } };
    expect(formatTranscriptData(data, 'My Custom Title')).toMatch(/^# My Custom Title\n/);
  });

  test('defaults to "Udemy Course Transcript" when no title provided', () => {
    const data = { 'Sec': { 'Lec': { sectionIndex: 0, lectureIndex: 0, transcript: ['hi'] } } };
    expect(formatTranscriptData(data)).toMatch(/^# Udemy Course Transcript\n/);
  });
});
