# Slop or Not!

A Chrome extension that detects AI-generated content in your LinkedIn feed.

**By [And/or Labs Inc.](https://adorlabs.ca)**

## What It Does

Slop or Not! analyzes LinkedIn posts in real-time and badges them as either **Human** or **Slop** based on 14 writing pattern heuristics derived from [Wikipedia's Signs of AI Writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

## Features

- **Real-time Detection** - Automatically analyzes posts as you scroll
- **Clear Verdicts** - Binary Human/Slop classification with explanatory commentary
- **14 Heuristics** - Based on documented AI writing patterns
- **Privacy-First** - All analysis happens locally in your browser. No data leaves your device.

## Detection Heuristics

| # | Pattern | What It Detects |
|---|---------|-----------------|
| 1 | AI Vocabulary | Words like "delve," "tapestry," "leverage," "robust" |
| 2 | Grandiose Language | "testament to," "plays a vital role," "cannot be overstated" |
| 3 | Rule of Three | Overuse of "X, Y, and Z" patterns |
| 4 | Participle Trailers | "...emphasizing the importance," "...paving the way" |
| 5 | Editorial Commentary | "It's important to note," "Interestingly," |
| 6 | Transition Spam | "Moreover," "Furthermore," "Additionally" |
| 7 | Parallel Negation | "This isn't X. It's Y." structures |
| 8 | Sentence Rhythm | Single-sentence paragraph patterns |
| 9 | List Parallelism | Perfectly parallel list items |
| 10 | Colon Lists | "Here's what matters:" followed by bullet points |
| 11 | Em Dash Spacing | Dramatic " — " pause patterns |
| 12 | Staccato Rhythm | Single newline dramatic breaks |
| 13 | Tired Metaphors | "low-hanging fruit," "move the needle," "deep dive" |
| 14 | Engagement Bait | "What do you think?" ending questions |

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `slop-or-not` folder
6. Visit LinkedIn and browse your feed

## Limitations

- **LinkedIn only** - Currently only works on linkedin.com
- **English only** - Heuristics are tuned for English text
- **Heuristic-based** - Not ML/AI detection; based on writing patterns
- **False positives possible** - Some human writers use AI-like patterns

## Privacy

Slop or Not! runs entirely in your browser. It does not:
- Send any data to external servers
- Track your browsing activity
- Store personal information
- Access any data outside LinkedIn

## Support

- **Bug reports**: slopornot@andorlabs.ca
- **Website**: [adorlabs.ca](https://adorlabs.ca)

## License

MIT License - Copyright (c) 2025 And/or Labs Inc.
