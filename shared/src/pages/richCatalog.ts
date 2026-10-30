/** Labels and examples for Michi's rich blocks, adapted from agent-desk 0c7e619. */
import type { PageBlockCatalogEntry } from './blockCatalog';
import { RICH_BLOCK_RULES, RICH_BLOCK_SCHEMAS, briefJsonSchema, richBlockJsonSchema, type RichBlockType } from './richBlocks';

/** Plain text for copy, history and assistant context; never executable markup. */
export function richContentText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(richContentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([key]) => !['type', 'id', 'rev', 'sources', 'edit', 'kind', 'tone', 'lang', 'selected', 'interaction', 'visibility', 'action'].includes(key))
    .map(([, item]) => richContentText(item)).filter(Boolean).join('\n');
}

const definitions = [
  {
    "type": "quote",
    "category": "text",
    "label": "Quote",
    "describe": "A quotation, cite optional.",
    "example": {
      "type": "quote",
      "text": "Ship the smallest thing.",
      "cite": "Ann"
    }
  },
  {
    "type": "divider",
    "category": "text",
    "label": "Divider",
    "describe": "A horizontal rule.",
    "example": {
      "type": "divider"
    }
  },
  {
    "type": "toc",
    "category": "text",
    "label": "Contents",
    "describe": "Contents: links to the headings on the page.",
    "example": {
      "type": "toc"
    }
  },
  {
    "type": "code",
    "category": "text",
    "label": "Code",
    "describe": "Highlighted code; lang like ts, py, sh.",
    "example": {
      "type": "code",
      "lang": "ts",
      "code": "const x = 1;"
    }
  },
  {
    "type": "diff",
    "category": "text",
    "label": "Code diff",
    "describe": "Line diff of before against after.",
    "example": {
      "type": "diff",
      "before": "a = 1",
      "after": "a = 2"
    }
  },
  {
    "type": "math",
    "category": "text",
    "label": "Formula",
    "describe": "A KaTeX formula; display:true sets it on its own line.",
    "example": {
      "type": "math",
      "tex": "E = mc^2",
      "display": true
    }
  },
  {
    "type": "mermaid",
    "category": "text",
    "label": "Flowchart",
    "describe": "Mermaid source for a flowchart or sequence diagram.",
    "example": {
      "type": "mermaid",
      "code": "graph LR; A-->B"
    }
  },
  {
    "type": "keyvalue",
    "category": "text",
    "label": "Key-value list",
    "describe": "Key and value pairs.",
    "example": {
      "type": "keyvalue",
      "items": [
        {
          "key": "Owner",
          "value": "Ann"
        }
      ]
    }
  },
  {
    "type": "tags",
    "category": "text",
    "label": "Tags",
    "describe": "Inline tags; tone as for callout.",
    "example": {
      "type": "tags",
      "items": [
        {
          "label": "urgent",
          "tone": "danger"
        },
        {
          "label": "docs"
        }
      ]
    }
  },
  {
    "type": "status",
    "category": "data",
    "label": "Status",
    "describe": "The page's overall verdict: label is a few words with a tone as for callout, summary the one-sentence state beside it, note a muted line on what it rests on. At most one, at the top of the page.",
    "example": {
      "type": "status",
      "label": "At risk",
      "tone": "warn",
      "summary": "Code is ahead of plan; merging and permissions are holding back delivery.",
      "note": "Based on the page reports up to Oct 23"
    }
  },
  {
    "type": "stat",
    "category": "data",
    "label": "Big number",
    "describe": "One big figure; delta with deltaTone up, down or flat; spark is a trend of numbers.",
    "example": {
      "type": "stat",
      "label": "Weekly users",
      "value": "1,240",
      "delta": "+12%",
      "deltaTone": "up",
      "spark": [
        3,
        5,
        4,
        8
      ]
    }
  },
  {
    "type": "progress",
    "category": "data",
    "label": "Progress bar",
    "describe": "Share done (0-1), against where the plan expected it by now.",
    "example": {
      "type": "progress",
      "title": "Done",
      "actual": 0.4,
      "expected": 0.6
    }
  },
  {
    "type": "ring",
    "category": "data",
    "label": "Progress ring",
    "describe": "Up to 8 progress rings, value 0-1.",
    "example": {
      "type": "ring",
      "items": [
        {
          "label": "Design",
          "value": 0.8
        }
      ]
    }
  },
  {
    "type": "gauge",
    "category": "data",
    "label": "Gauge",
    "describe": "A value on a dial from min to max.",
    "example": {
      "type": "gauge",
      "title": "CPU",
      "value": 63,
      "min": 0,
      "max": 100,
      "unit": "%"
    }
  },
  {
    "type": "leaderboard",
    "category": "data",
    "label": "Leaderboard",
    "describe": "Ranked by numeric value, highest first.",
    "example": {
      "type": "leaderboard",
      "title": "Top pages",
      "items": [
        {
          "name": "/home",
          "value": 420
        },
        {
          "name": "/docs",
          "value": 310
        }
      ]
    }
  },
  {
    "type": "rating",
    "category": "data",
    "label": "Rating",
    "describe": "A score 0-5 per item.",
    "example": {
      "type": "rating",
      "items": [
        {
          "label": "Location",
          "score": 4.5
        }
      ]
    }
  },
  {
    "type": "pros-cons",
    "category": "data",
    "label": "Pros and cons",
    "describe": "Pros and cons as two lists.",
    "example": {
      "type": "pros-cons",
      "pros": [
        "Fast"
      ],
      "cons": [
        "Costly"
      ]
    }
  },
  {
    "type": "choice",
    "category": "data",
    "label": "Choice",
    "describe": "A question with options; selecting one sends the visible question and answer to the Assistant.",
    "example": {
      "type": "choice",
      "question": "Which route?",
      "options": [
        "East",
        "West"
      ]
    }
  },
  {
    "type": "milestones",
    "category": "time",
    "label": "Milestones",
    "describe": "Dated milestones in order, drawn as a track across the page (a list in a narrow pane). done marks the ones passed; the first not done shows as next. note is a short status line under the label; tone as for callout marks one at risk or blocked.",
    "example": {
      "type": "milestones",
      "items": [
        {
          "label": "Spec",
          "date": "2026-10-01",
          "done": true
        },
        {
          "label": "Beta",
          "date": "2026-11-01",
          "done": false,
          "note": "Waiting on the security review",
          "tone": "warn"
        },
        {
          "label": "Launch",
          "date": "2026-12-01",
          "done": false
        }
      ]
    }
  },
  {
    "type": "stepper",
    "category": "time",
    "label": "Steps",
    "describe": "Steps; current is the 0-based step under way, the step count once all are done.",
    "example": {
      "type": "stepper",
      "steps": [
        {
          "label": "Draft"
        },
        {
          "label": "Review"
        },
        {
          "label": "Ship"
        }
      ],
      "current": 1
    }
  },
  {
    "type": "agenda",
    "category": "time",
    "label": "Agenda",
    "describe": "One day's schedule: time, title, note.",
    "example": {
      "type": "agenda",
      "date": "2026-10-20",
      "items": [
        {
          "time": "09:00",
          "title": "Standup"
        }
      ]
    }
  },
  {
    "type": "calendar",
    "category": "time",
    "label": "Month calendar",
    "describe": "One month (YYYY-MM) with events on its days (YYYY-MM-DD).",
    "example": {
      "type": "calendar",
      "month": "2026-10",
      "events": [
        {
          "date": "2026-10-20",
          "title": "Flight"
        }
      ]
    }
  },
  {
    "type": "gantt",
    "category": "time",
    "label": "Gantt chart",
    "describe": "Bars from start to end (YYYY-MM-DD), with group and done 0-1.",
    "example": {
      "type": "gantt",
      "items": [
        {
          "label": "Build",
          "start": "2026-10-01",
          "end": "2026-10-14",
          "done": 0.5
        }
      ]
    }
  },
  {
    "type": "countdown",
    "category": "time",
    "label": "Countdown",
    "describe": "Time left until \"to\", an ISO date or date-time.",
    "example": {
      "type": "countdown",
      "title": "Launch",
      "to": "2026-11-01T09:00:00Z"
    }
  },
  {
    "type": "clocks",
    "category": "time",
    "label": "World clocks",
    "describe": "Clocks for IANA time zones, computed on the device.",
    "example": {
      "type": "clocks",
      "zones": [
        {
          "label": "Tokyo",
          "tz": "Asia/Tokyo"
        },
        {
          "label": "NYC",
          "tz": "America/New_York"
        }
      ]
    }
  },
  {
    "type": "image",
    "category": "media",
    "label": "Image",
    "describe": "One image.",
    "example": {
      "type": "image",
      "url": "https://example.com/a.jpg",
      "alt": "Lobby"
    }
  },
  {
    "type": "before-after",
    "category": "media",
    "label": "Before and after",
    "describe": "Two images, before and after, compared with a slider.",
    "example": {
      "type": "before-after",
      "before": "https://example.com/old.png",
      "after": "https://example.com/new.png"
    }
  },
  {
    "type": "carousel",
    "category": "media",
    "label": "Carousel",
    "describe": "Images one at a time, swiped through.",
    "example": {
      "type": "carousel",
      "items": [
        {
          "url": "https://example.com/a.jpg",
          "caption": "Day 1"
        }
      ]
    }
  },
  {
    "type": "video",
    "category": "media",
    "label": "Video",
    "describe": "A video file, or a YouTube or Vimeo page.",
    "example": {
      "type": "video",
      "url": "https://youtu.be/dQw4w9WgXcQ"
    }
  },
  {
    "type": "audio",
    "category": "media",
    "label": "Audio",
    "describe": "An audio file.",
    "example": {
      "type": "audio",
      "url": "https://example.com/a.mp3"
    }
  },
  {
    "type": "embed",
    "category": "media",
    "label": "Embedded page",
    "describe": "A live web page in a frame, height 120-1200.",
    "example": {
      "type": "embed",
      "url": "https://example.com",
      "height": 480
    }
  },
  {
    "type": "link",
    "category": "media",
    "label": "Link card",
    "describe": "Link card; you write its title, description, image and site, nothing is fetched.",
    "example": {
      "type": "link",
      "url": "https://example.com/post",
      "title": "Release notes",
      "site": "example.com"
    }
  },
  {
    "type": "file",
    "category": "media",
    "label": "File card",
    "describe": "A file by path with a note; the path is shown as text, not a link.",
    "example": {
      "type": "file",
      "path": "docs/plan.md",
      "note": "Latest plan"
    }
  },
  {
    "type": "person",
    "category": "media",
    "label": "Person card",
    "describe": "A person: name, role, avatar image, note, links.",
    "example": {
      "type": "person",
      "name": "Ann Lee",
      "role": "Designer",
      "links": [
        {
          "label": "Site",
          "url": "https://example.com"
        }
      ]
    }
  },
  {
    "type": "place",
    "category": "media",
    "label": "Place card",
    "describe": "A place: name, address, note; opens in a maps app, no map is drawn.",
    "example": {
      "type": "place",
      "name": "Kyoto Station",
      "address": "Kyoto, Japan"
    }
  },
  {
    "type": "actions",
    "category": "decisions",
    "label": "Buttons",
    "describe": "Buttons that fill the visible Assistant input with their prompt for review before sending.",
    "example": {
      "type": "actions",
      "buttons": [
        {
          "label": "Draft reply",
          "prompt": "Draft a reply to the vendor"
        }
      ]
    }
  },
  {
    "type": "form",
    "category": "decisions",
    "label": "Form",
    "describe": "A form that fills the visible Assistant input with its prompt and answers for review before sending.",
    "example": {
      "type": "form",
      "title": "Trip",
      "fields": [
        {
          "key": "city",
          "label": "City",
          "type": "text",
          "required": true
        }
      ],
      "prompt": "Plan a trip with these answers"
    }
  },
  {
    "type": "poll",
    "category": "decisions",
    "label": "Poll",
    "describe": "A question with 2 or more options. Submit sends only the visible question and selected answers to the Assistant.",
    "example": {
      "type": "poll",
      "question": "Lunch?",
      "options": [
        "Ramen",
        "Sushi"
      ]
    }
  }
] as const;

export const RICH_BLOCK_CATALOG = Object.fromEntries(definitions.map((entry) => {
  const schema = richBlockJsonSchema(RICH_BLOCK_SCHEMAS[entry.type]);
  const rule = RICH_BLOCK_RULES[entry.type];
  return [entry.type, {
    ...entry, blurb: entry.describe, schema,
    // Written from the schema the write is checked against, so the two cannot drift apart.
    fields: `${briefJsonSchema(schema)}${rule ? `; ${rule}` : ''}`,
    title: (b: Record<string, unknown>) => String(b.title ?? b.question ?? b.name ?? b.label ?? ''),
    text: (block: unknown) => richContentText(block) || entry.label,
  }];
})) as unknown as { readonly [T in RichBlockType]: PageBlockCatalogEntry<T> };
