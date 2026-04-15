// Slop or Not - LinkedIn AI Content Detector

(function() {
  'use strict';

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[Slop or Not]', ...args);

  class SlopDetector {
    constructor() {
      this.analyzedPosts = new Set();
      this.pendingPosts = new Map(); // postId -> {element, truncatedLength}
      this.stats = { total: 0, scores: { 1: 0, 2: 0 } };
      this.blockSlop = true; // default: auto-erase slop posts
      this.scanTimeout = null;
      this._aiWordRegexes = null;
      this._transitionRegexes = null;
      this._commentObserver = null;

      // Listen for setting changes from popup (once, in constructor)
      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes) => {
          if (changes.slopBlockEnabled) {
            this.blockSlop = changes.slopBlockEnabled.newValue;
            this.applyBlockSetting();
          }
          if (changes.slopStats) {
            const newStats = changes.slopStats.newValue;
            if (newStats && newStats.total === 0) {
              this.stats = { total: 0, scores: { 1: 0, 2: 0 } };
            }
          }
        });
      }

      this.loadSettings().then(() => this.init());
    }

    async loadSettings() {
      try {
        if (chrome?.storage?.local) {
          const result = await chrome.storage.local.get(['slopStats', 'slopBlockEnabled']);
          if (result.slopStats) {
            this.stats = result.slopStats;
            log('Loaded stats from storage:', this.stats);
          }
          if (result.slopBlockEnabled !== undefined) {
            this.blockSlop = result.slopBlockEnabled;
          }
        }
      } catch (e) {
        log('Could not load settings:', e);
      }
    }

    _compileRegexes() {
      if (this._aiWordRegexes) return;

      const aiWords = [
        'delve', 'delving', 'delved',
        'tapestry', 'multifaceted', 'comprehensive',
        'intricate', 'intricacies', 'nuanced', 'multitude',
        'realm', 'paradigm', 'ethos',
        'embark', 'beacon', 'testament',
        'pivotal', 'paramount', 'profound',
        'meticulous', 'meticulously',
        'intrinsic', 'intrinsically',
        'resonate', 'resonates', 'resonating',
        'foster', 'fostering', 'fosters',
        'leverage', 'leveraging', 'leveraged',
        'navigate', 'navigating', 'navigates',
        'elevate', 'elevating', 'elevates',
        'underscore', 'underscores', 'underscoring',
        'robust', 'robustly',
        'seamless', 'seamlessly',
        'vibrant', 'bustling',
        'bespoke', 'tailor-made',
        'nuance', 'nuances',
        'landscape', 'journey', 'ecosystem',
        'holistic', 'holistically',
        'synergy', 'synergies',
        'endeavor', 'endeavors',
        'cornerstone',
        'spearhead', 'spearheading',
        'bolster', 'bolstering', 'bolstered',
        'augment', 'augmenting',
        'harness', 'harnessing',
        'cultivate', 'cultivating',
        'aligns', 'aligning',
        'streamline', 'streamlining',
        'optimize', 'optimizing',
        'revolutionize', 'revolutionizing',
        'transformative', 'transform',
        'game-changer', 'game-changing',
        'cutting-edge', 'cutting edge',
        'groundbreaking', 'trailblazing',
        'unparalleled', 'unrivaled', 'unprecedented',
        'garner', 'garnered', 'garnering',
        'boasts', 'boasting', 'interplay', 'enduring',
        'enhance', 'enhancing', 'enhanced',
        'showcasing', 'showcased',
        'highlighting', 'highlighted',
        'crucial', 'align with',
        'facilitate', 'facilitating',
        'encompass', 'encompassing',
        'elucidate', 'elucidating',
        'amplify', 'amplifying',
        'underpinnings', 'treasure trove',
        'systemic',
        'unleash', 'unleashing',
        'empower', 'empowering',
        'noteworthy', 'commendable', 'underscored'
      ];

      this._aiWordRegexes = aiWords.map(w => new RegExp(`\\b${w}\\b`, 'gi'));

      const transitions = [
        'moreover', 'furthermore', 'additionally', 'in addition',
        'consequently', 'subsequently', 'nevertheless', 'nonetheless',
        'hence', 'thus', 'therefore', 'accordingly',
        'on the other hand', 'conversely', 'in contrast',
        'similarly', 'likewise', 'as such',
        'that said', 'that being said', 'with that in mind',
        'in light of this', 'given this',
        'firstly', 'secondly', 'thirdly', 'lastly', 'finally'
      ];

      this._transitionRegexes = transitions.map(t => new RegExp(`\\b${t}\\b`, 'gi'));
    }

    init() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.start());
      } else {
        this.start();
      }
    }

    start() {
      log('Starting detector...');

      // Initial scan
      this.debouncedScan();

      // Watch for DOM changes with debouncing
      this.observeChanges();

      // Listen for clicks on "see more" buttons
      document.addEventListener('click', (e) => this.handleClick(e), true);

      // Single delegated observer for all comments
      this._observeComments();

      // Save stats periodically
      setInterval(() => this.saveStats(), 5000);
    }

    _observeComments() {
      if (this._commentObserver) return;

      const commentSelectors = [
        '.comments-comment-item',
        '.comments-comment-entity',
        '[data-test-id*="comment"]',
        '[id*="comment-"]',
        '.feed-shared-update-v2__comments-container .artdeco-card'
      ];

      this._commentObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            // Check if the added node is a comment or contains comments
            for (const selector of commentSelectors) {
              if (node.matches?.(selector)) {
                this.analyzeComment(node);
              }
              const nested = node.querySelectorAll?.(selector);
              if (nested) nested.forEach(c => this.analyzeComment(c));
            }
          }
        }
      });

      this._commentObserver.observe(document.body, { childList: true, subtree: true });
    }

    observeChanges() {
      const observer = new MutationObserver(() => {
        this.debouncedScan();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    debouncedScan() {
      if (this.scanTimeout) {
        clearTimeout(this.scanTimeout);
      }
      this.scanTimeout = setTimeout(() => this.scanForPosts(), 300);
    }

    handleClick(e) {
      // Check if clicked element is a "see more" type button
      const target = e.target;
      const text = (target.textContent || '').toLowerCase().trim();
      const ariaLabel = (target.getAttribute('aria-label') || '').toLowerCase();

      // Very specific matching for LinkedIn's "...more" button
      const isMoreButton = text === '…more' || text === '...more' || text === 'see more' ||
        ariaLabel.includes('see more');
      if (isMoreButton) {
        log('See more clicked, will re-scan in 500ms');
        // Wait for content to expand, then re-scan
        setTimeout(() => {
          // Find the parent post and force re-analysis
          const post = target.closest('[data-urn*="urn:li:activity"]') ||
                       target.closest('[role="article"]');
          if (post) {
            const postId = this.getPostId(post);
            if (postId && this.pendingPosts.has(postId)) {
              log('Re-analyzing expanded post:', postId.substring(0, 30));
              this.pendingPosts.delete(postId);
              this.analyzePost(post, postId);
            }
          }
        }, 500);
      }
    }

    scanForPosts() {
      // Find all feed posts
      const posts = document.querySelectorAll('[data-urn*="urn:li:activity"]');

      log(`Found ${posts.length} posts`);

      posts.forEach(post => {
        const postId = this.getPostId(post);
        if (!postId) return;

        // Skip if already analyzed
        if (this.analyzedPosts.has(postId)) return;

        // Check if this post has a "see more" button in its TEXT content area
        const isTruncated = this.isPostTruncated(post);
        const textContent = this.extractPostText(post);
        const textLength = textContent ? textContent.length : 0;

        log('Checking post:', {
          id: postId.substring(0, 40),
          isTruncated,
          textLength,
          preview: textContent?.substring(0, 50)
        });

        if (isTruncated) {
          // Store as pending, wait for expansion
          if (!this.pendingPosts.has(postId)) {
            this.pendingPosts.set(postId, { element: post, truncatedLength: textLength });
            log('Post is truncated, waiting for expansion');
          }
          return;
        }

        // Not truncated or already expanded - analyze it
        this.analyzePost(post, postId);
      });
    }

    getPostId(post) {
      return post.getAttribute('data-urn') || null;
    }

    isPostTruncated(post) {
      // Look specifically for the "...more" button within the post's text container
      // LinkedIn wraps the post text in specific containers

      // First, find the text content area (not the whole post which has "more comments" etc)
      const textContainer = post.querySelector(
        '.feed-shared-update-v2__description, ' +
        '.update-components-text, ' +
        '[data-test-id*="commentary"], ' +
        '.feed-shared-text-view'
      );

      if (!textContainer) {
        // If we can't find a specific text container, look in the general area
        // but be very specific about what we're looking for
        const allText = post.querySelectorAll('span, button');
        for (const el of allText) {
          const text = (el.textContent || '').trim();
          // Must be EXACTLY "…more" or "...more" - not "1 more" or "see more comments"
          if (text === '…more' || text === '...more') {
            // Check it's not inside comments section
            const inComments = el.closest('[class*="comment"]');
            if (!inComments) {
              return true;
            }
          }
        }
        return false;
      }

      // Search within the text container only
      const moreButtons = textContainer.querySelectorAll('button, span, a');
      for (const btn of moreButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === '…more' || text === '...more' || text === 'see more') {
          return true;
        }
        // aria-label fallback
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (ariaLabel.includes('see more')) {
          return true;
        }
      }

      return false;
    }

    extractPostText(post) {
      // Target the actual post content, not metadata
      const selectors = [
        '.feed-shared-update-v2__description .update-components-text',
        '.feed-shared-update-v2__description',
        '.update-components-text',
        '[data-test-id*="commentary"]',
        '.feed-shared-text-view',
        '.feed-shared-inline-show-more-text'
      ];

      for (const selector of selectors) {
        const element = post.querySelector(selector);
        if (element) {
          // Get text but filter out the "...more" button text
          let text = element.innerText || element.textContent || '';
          text = text.replace(/…more/g, '').replace(/\.\.\.more/g, '').replace(/see more/gi, '');
          text = text.trim();
          if (text.length > 20) {
            return text;
          }
        }
      }

      return null;
    }

    analyzePost(post, postId) {
      const textContent = this.extractPostText(post);

      if (!textContent || textContent.length < 50) {
        log('Skipping - insufficient text content');
        return;
      }

      log('Analyzing:', {
        id: postId.substring(0, 40),
        length: textContent.length,
        preview: textContent.substring(0, 100)
      });

      // Calculate score
      const { score, breakdown } = this.calculateScore(textContent);

      log('Score breakdown:', breakdown, '→ Total:', score, '→ Level:', this.mapScoreToLevel(score));

      // Mark as analyzed
      this.analyzedPosts.add(postId);
      this.pendingPosts.delete(postId);

      // Update stats
      const level = this.mapScoreToLevel(score);
      this.stats.total++;
      this.stats.scores[level]++;

      // Extract author name and generate commentary
      const authorName = this.extractAuthorName(post);
      const commentary = this.generateCommentary(breakdown, level, authorName);
      this.injectBadge(post, level, commentary);
    }

    // ========================================
    // HEURISTICS SYSTEM
    // Based on Wikipedia's "Signs of AI Writing"
    // https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
    // ========================================

    calculateScore(text) {
      const breakdown = {};
      let score = 0;

      // Wikipedia-based AI writing detection heuristics (1-6)

      // 1. AI Vocabulary Words (Wikipedia + AI Phrase Finder top 100)
      breakdown.vocab = this.checkAIVocabulary(text);
      score += breakdown.vocab;

      // 2. Grandiose/Promotional Language
      breakdown.grandiose = this.checkGrandioseLanguage(text);
      score += breakdown.grandiose;

      // 3. Rule of Three Pattern
      breakdown.ruleOfThree = this.checkRuleOfThree(text);
      score += breakdown.ruleOfThree;

      // 4. Present Participle Trailing Clauses ("emphasizing the importance")
      breakdown.participle = this.checkParticipleTrailers(text);
      score += breakdown.participle;

      // 5. Editorial Commentary ("it's important to note")
      breakdown.editorial = this.checkEditorialCommentary(text);
      score += breakdown.editorial;

      // 6. Excessive Transitions (moreover, furthermore)
      breakdown.transitions = this.checkTransitionSpam(text);
      score += breakdown.transitions;

      // Structural AI patterns (7-10)

      // 7. Parallel Negation Patterns
      breakdown.parallelNegation = this.checkParallelNegation(text);
      score += breakdown.parallelNegation;

      // 8. Single-Sentence Paragraph Rhythm
      breakdown.sentenceRhythm = this.checkSentenceRhythm(text);
      score += breakdown.sentenceRhythm;

      // 9. Perfect List Parallelism
      breakdown.listParallelism = this.checkListParallelism(text);
      score += breakdown.listParallelism;

      // 10. Colon-Introduced Lists
      breakdown.colonLists = this.checkColonLists(text);
      score += breakdown.colonLists;

      // 11. Em Dash Spacing (strong AI signal)
      breakdown.emDash = this.checkEmDashSpacing(text);
      score += breakdown.emDash;

      // 12. Single Newline Staccato (very strong AI signal)
      breakdown.staccato = this.checkStaccatoRhythm(text);
      score += breakdown.staccato;

      // 13. Tired Business Metaphors
      breakdown.metaphors = this.checkTiredMetaphors(text);
      score += breakdown.metaphors;

      // 14. Engagement Bait Questions
      breakdown.engagementBait = this.checkEngagementBait(text);
      score += breakdown.engagementBait;

      // 15. Curly Quotation Marks (Wikipedia: ChatGPT/DeepSeek use curly quotes)
      breakdown.curlyQuotes = this.checkCurlyQuotes(text);
      score += breakdown.curlyQuotes;

      // 16. Promotional/Marketing Tone (Wikipedia: "scenic", "breathtaking", commercial-esque)
      breakdown.promotional = this.checkPromotionalTone(text);
      score += breakdown.promotional;

      // 17. Emoji Bullet Spam (3+ lines starting with same emoji)
      breakdown.emojiPointers = this.checkEmojiPointers(text);
      score += breakdown.emojiPointers;

      return { score, breakdown };
    }

    // Heuristic 1: AI Vocabulary Words
    // From Wikipedia's "Signs of AI writing" + AI Phrase Finder's top 100
    // https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
    checkAIVocabulary(text) {
      this._compileRegexes();
      const lower = text.toLowerCase();
      let matches = 0;

      for (const regex of this._aiWordRegexes) {
        regex.lastIndex = 0;
        if (regex.test(lower)) matches++;
      }

      if (matches >= 5) return -4;
      if (matches >= 3) return -2;
      return 0;
    }

    // Heuristic 2: Grandiose/Promotional Language
    // Wikipedia: "stands as a testament", "plays a vital role", "breathtaking"
    checkGrandioseLanguage(text) {
      const phrases = [
        // Testament/legacy patterns
        'stands as a testament',
        'serves as a testament',
        'testament to',
        'enduring legacy',
        'lasting legacy',
        'indelible mark',
        'left an indelible',

        // Vital/crucial patterns
        'plays a vital role',
        'plays a crucial role',
        'plays a pivotal role',
        'plays an important role',
        'of paramount importance',
        'cannot be overstated',

        // Promotional superlatives
        'rich cultural heritage',
        'rich history',
        'breathtaking',
        'stunning',
        'awe-inspiring',
        'world-class',
        'best-in-class',
        'industry-leading',
        'thought leader',
        'visionary',
        'trailblazer',

        // Symbolism patterns
        'symbolizes',
        'embodies the spirit',
        'epitomizes',
        'exemplifies',

        // Significance inflation
        'a pivotal moment',
        'a watershed moment',
        'a turning point',
        'marks a significant',
        'represents a major',
        'a major milestone'
      ];

      const lower = text.toLowerCase();
      let matches = 0;

      for (const phrase of phrases) {
        if (lower.includes(phrase)) matches++;
      }

      if (matches >= 2) return -4;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 3: Rule of Three Pattern
    // Wikipedia: LLMs overuse "adjective, adjective, adjective" and "phrase, phrase, and phrase"
    checkRuleOfThree(text) {
      let matches = 0;

      // Pattern: "X, Y, and Z" where X, Y, Z are similar length phrases
      const triplePattern = /(\w+(?:\s+\w+)?), (\w+(?:\s+\w+)?), and (\w+(?:\s+\w+)?)/gi;
      const tripleMatches = text.match(triplePattern) || [];
      matches += tripleMatches.length;

      // Pattern: Three adjectives in a row
      const adjectiveTriple = /\b(\w+), (\w+), and (\w+)\b/gi;
      const adjMatches = text.match(adjectiveTriple) || [];
      matches += adjMatches.length;

      // Pattern: Colon followed by three items
      const colonTriple = /:\s*(\w+(?:\s+\w+)*),\s*(\w+(?:\s+\w+)*),\s*and\s*(\w+(?:\s+\w+)*)/gi;
      const colonMatches = text.match(colonTriple) || [];
      matches += colonMatches.length;

      if (matches >= 2) return -2;
      return 0;
    }

    // Heuristic 4: Present Participle Trailing Clauses
    // Wikipedia: "emphasizing the significance", "reflecting the importance"
    checkParticipleTrailers(text) {
      const patterns = [
        /,?\s+(emphasizing|highlighting|underscoring|reflecting|demonstrating|showcasing|illustrating|signifying|representing)\s+(the|its|their|a)\s+(importance|significance|relevance|impact|value|commitment|dedication)/gi,
        /,?\s+(marking|signaling|heralding)\s+a\s+(new|major|significant|important)/gi,
        /,?\s+(paving the way|setting the stage|laying the groundwork)/gi,
        /,?\s+(cementing|solidifying|reinforcing)\s+(its|their|his|her)\s+(position|status|reputation|legacy)/gi
      ];

      let matches = 0;
      for (const pattern of patterns) {
        const found = text.match(pattern) || [];
        matches += found.length;
      }

      if (matches >= 2) return -3;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 5: Editorial Commentary
    // Wikipedia: "it's important to note", "it is worth mentioning"
    checkEditorialCommentary(text) {
      const phrases = [
        "it's important to note",
        "it is important to note",
        "it's worth noting",
        "it is worth noting",
        "it's worth mentioning",
        "it is worth mentioning",
        "importantly,",
        "significantly,",
        "notably,",
        "interestingly,",
        "crucially,",
        "remarkably,",
        "it should be noted",
        "one must consider",
        "it bears mentioning",
        "needless to say",
        "it goes without saying",
        "no discussion.*would be complete without",
        "in summary,",
        "in conclusion,",
        "to summarize,",
        "to conclude,",
        "overall,",
        "all in all,",
        "at the end of the day"
      ];

      const lower = text.toLowerCase();
      let matches = 0;

      for (const phrase of phrases) {
        if (phrase.includes('.*')) {
          const regex = new RegExp(phrase, 'i');
          if (regex.test(lower)) matches++;
        } else if (lower.includes(phrase)) {
          matches++;
        }
      }

      if (matches >= 2) return -3;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 6: Excessive Transitions
    // Wikipedia: "moreover", "furthermore"
    checkTransitionSpam(text) {
      this._compileRegexes();
      const lower = text.toLowerCase();
      let matches = 0;

      for (const regex of this._transitionRegexes) {
        regex.lastIndex = 0;
        const found = lower.match(regex) || [];
        matches += found.length;
      }

      if (matches >= 4) return -2;
      return 0;
    }

    // Heuristic 7: Parallel Negation Patterns
    // AI loves "The X isn't Y. The X is Z." or "This isn't X. It's Y."
    checkParallelNegation(text) {
      const patterns = [
        // "The X isn't Y. The X is Z."
        /The \w+\s+(?:isn't|is not|aren't|are not|wasn't|were not)\s+\w+\.\s*The \w+\s+is\s+/gi,
        // "This isn't X. It's Y." / "This isn't X. This is Y."
        /(?:This|That|It)\s+(?:isn't|is not|wasn't|was not)\s+[^.]+\.\s*(?:This|That|It'?s?)\s+is\s+/gi,
        // Repeated structure: "X isn't... X isn't... X isn't..."
        /(\w+\s+(?:isn't|is not|aren't|are not)[^.]+\.)\s*\1/gi
      ];

      let matches = 0;
      for (const pattern of patterns) {
        const found = text.match(pattern) || [];
        matches += found.length;
      }

      if (matches >= 3) return -4;
      if (matches >= 2) return -3;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 8: Single-Sentence Paragraph Rhythm
    // AI-generated essays often have perfect single-sentence paragraph cadence
    checkSentenceRhythm(text) {
      const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 15);

      // Need enough paragraphs to detect pattern
      if (paragraphs.length < 4) return 0;

      let singleSentence = 0;
      for (const p of paragraphs) {
        // Count sentences (split by . ! ?)
        const sentences = p.split(/[.!?]+/).filter(s => s.trim().length > 5);
        if (sentences.length === 1) singleSentence++;
      }

      const ratio = singleSentence / paragraphs.length;

      // High ratio of single-sentence paragraphs in formal writing is AI-like
      if (ratio >= 0.75 && paragraphs.length >= 6) return -3;
      if (ratio >= 0.6 && paragraphs.length >= 4) return -2;
      return 0;
    }

    // Heuristic 9: Perfect List Parallelism
    // AI creates perfectly parallel lists where all items start identically
    checkListParallelism(text) {
      const lines = text.split('\n');
      let perfectLists = 0;

      // Look for bullet/numbered list patterns
      for (let i = 0; i < lines.length - 2; i++) {
        const line1 = lines[i].trim();
        const line2 = lines[i + 1].trim();
        const line3 = lines[i + 2].trim();

        // Check if these look like list items
        if (this.isListItem(line1) && this.isListItem(line2) && this.isListItem(line3)) {
          // Extract text after bullet/number
          const text1 = this.extractListText(line1);
          const text2 = this.extractListText(line2);
          const text3 = this.extractListText(line3);

          // Check if they start with same word or same structure
          const words1 = text1.split(/\s+/);
          const words2 = text2.split(/\s+/);
          const words3 = text3.split(/\s+/);

          if (words1.length > 0 && words2.length > 0 && words3.length > 0) {
            if (words1[0].toLowerCase() === words2[0].toLowerCase() &&
                words2[0].toLowerCase() === words3[0].toLowerCase()) {
              perfectLists++;
            }
          }
        }
      }

      if (perfectLists >= 2) return -3;
      if (perfectLists >= 1) return -2;
      return 0;
    }

    // Helper: Check if line looks like list item
    isListItem(line) {
      return /^[\s]*(?:[-•\*\d]+[\.\)]|\d+\.)\s+\w/.test(line);
    }

    // Helper: Extract text after list marker
    extractListText(line) {
      return line.replace(/^[\s]*(?:[-•\*\d]+[\.\)]|\d+\.)\s+/, '');
    }

    // Heuristic 10: Colon-Introduced Lists
    // AI loves "Here's what matters:" followed by perfect list
    checkColonLists(text) {
      // Pattern: sentence ending in colon, followed by list items
      const colonPattern = /[^:\n]+:\s*\n/g;

      // Use matchAll to get correct positions for duplicate patterns
      let colonLists = 0;
      for (const match of text.matchAll(colonPattern)) {
        const index = match.index;
        const afterColon = text.substring(index + match[0].length, index + match[0].length + 200);

        // Check if next lines are list items
        const nextLines = afterColon.split('\n').slice(0, 4);
        let listItems = 0;
        for (const line of nextLines) {
          if (this.isListItem(line.trim())) listItems++;
        }

        if (listItems >= 2) colonLists++;
      }

      if (colonLists >= 3) return -3;
      if (colonLists >= 2) return -2;
      return 0;
    }

    // Heuristic 11: Em Dash with Spaces
    // AI loves " — " (space-em dash-space) for dramatic pauses
    // This is a VERY strong signal - humans rarely format this way
    checkEmDashSpacing(text) {
      // Match em dash (—) or double/triple hyphen (-- or ---) with spaces on both sides
      const emDashPattern = /\s(—|–|--)\s/g;
      const matches = text.match(emDashPattern) || [];
      const count = matches.length;

      // This is such a strong signal that even 1-2 instances should heavily weight toward Slop
      if (count >= 3) return -6;
      if (count >= 2) return -4;
      if (count >= 1) return -3;
      return 0;
    }

    // Heuristic 12: Single Newline Staccato Rhythm
    // AI uses single \n for dramatic sentence breaks instead of proper \n\n paragraph breaks
    // Pattern: "Sentence.\nNew sentence." instead of "Sentence.\n\nNew paragraph."
    checkStaccatoRhythm(text) {
      // Look for sentence endings followed by single newline and capital letter
      // This indicates sentence breaks without proper paragraph spacing
      const staccatoPattern = /[.!?]\n[A-Z]/g;
      const matches = text.match(staccatoPattern) || [];
      const singleNewlineBreaks = matches.length;

      // Also check for very short lines (< 60 chars) which indicates fragmentation
      const lines = text.split('\n');
      const shortLines = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed.length > 0 && trimmed.length < 60 && /[.!?]$/.test(trimmed);
      }).length;

      // High ratio of staccato breaks or many short dramatic lines = AI
      if (singleNewlineBreaks >= 8 || shortLines >= 10) return -6;
      if (singleNewlineBreaks >= 5 || shortLines >= 7) return -4;
      if (singleNewlineBreaks >= 3 || shortLines >= 5) return -3;
      return 0;
    }

    // Heuristic 13: Tired Business Metaphors
    // AI loves overused business clichés
    checkTiredMetaphors(text) {
      const metaphors = [
        // Physical metaphors
        'three-legged stool',
        'two sides of the same coin',
        'tip of the iceberg',
        'low-hanging fruit',
        'move the needle',
        'moving the goalposts',
        'shift gears',
        'hit the ground running',
        'all hands on deck',
        'boots on the ground',

        // Journey/path metaphors
        'at the end of the day',
        'when all is said and done',
        'at this point in time',
        'circle back',
        'take it offline',
        'touch base',
        'on the same page',

        // Business jargon metaphors
        'think outside the box',
        'drink the kool-aid',
        'boil the ocean',
        'drinking from a firehose',
        'run it up the flagpole',
        'synergy',
        'leverage synergies',
        'move forward',
        'going forward',
        'take a step back',

        // Scale/growth metaphors
        '10x',
        'scale up',
        'double down',
        'deep dive',
        'drill down',
        'take a holistic view',
        'from 30,000 feet',
        'high-level overview'
      ];

      const lower = text.toLowerCase();
      let matches = 0;

      for (const metaphor of metaphors) {
        if (lower.includes(metaphor)) matches++;
      }

      if (matches >= 3) return -4;
      if (matches >= 2) return -3;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 14: Engagement Bait Questions
    // AI posts often end with questions to drive engagement
    checkEngagementBait(text) {
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) return 0;

      // Check last 2 lines for engagement patterns
      const lastLines = lines.slice(-2).join(' ').toLowerCase();

      const baitPatterns = [
        // Question patterns
        /what('s| is) your (take|thought|opinion|experience|perspective)/i,
        /what do you think/i,
        /how (do|would) you/i,
        /have you (ever|experienced)/i,
        /what (was|were) the last/i,
        /what are you (doing|working)/i,
        /who else (agrees|disagrees)/i,

        // Call to action patterns
        /let me know in the comments/i,
        /drop (your|a) comment/i,
        /share (your|this)/i,
        /tag someone who/i,
        /agree or disagree/i,
        /sound off below/i,
        /weigh in/i,

        // Emoji question indicators
        /[❓⁉️]/
      ];

      for (const pattern of baitPatterns) {
        if (pattern.test(lastLines)) {
          return -3;
        }
      }

      return 0;
    }

    // Heuristic 15: Curly Quotation Marks
    // Wikipedia: ChatGPT and DeepSeek use curly quotes (\u201c \u201d) instead of straight quotes
    // Mixed curly+straight in the same text is especially suspicious
    checkCurlyQuotes(text) {
      const curlyDoubleOpen = (text.match(/\u201c/g) || []).length;
      const curlyDoubleClose = (text.match(/\u201d/g) || []).length;
      const curlySingleOpen = (text.match(/\u2018/g) || []).length;
      const curlySingleClose = (text.match(/\u2019/g) || []).length;
      const totalCurly = curlyDoubleOpen + curlyDoubleClose + curlySingleOpen + curlySingleClose;

      const straightDouble = (text.match(/"/g) || []).length;

      // Mixed curly and straight quotes = strong AI signal
      if (totalCurly > 0 && straightDouble > 0) return -3;
      // Many curly quotes alone is still a signal on LinkedIn (people type straight quotes)
      if (totalCurly >= 4) return -2;
      return 0;
    }

    // Heuristic 16: Promotional/Marketing Tone
    // Wikipedia: AI defaults to commercial-friendly adjectives, press-release tone
    checkPromotionalTone(text) {
      const patterns = [
        'active social media presence',
        'maintain an active',
        'maintains an active',
        'clean and modern',
        'state-of-the-art',
        'a wide range of',
        'a diverse range of',
        'a broad spectrum of',
        'rich tapestry of',
        'continued relevance',
        'continued significance',
        'cultural landscape',
        'artistic expression',
        'dynamic landscape',
        'ever-evolving',
        'ever-changing',
        'rapidly evolving',
        'increasingly important',
        'remains committed',
        'a hub for',
        'a beacon of',
        'poised to',
        'well-positioned',
        'at the forefront',
        'pushing the boundaries',
        'raising the bar',
        'setting the standard'
      ];

      const lower = text.toLowerCase();
      let matches = 0;
      for (const p of patterns) {
        if (lower.includes(p)) matches++;
      }

      if (matches >= 3) return -4;
      if (matches >= 2) return -3;
      if (matches >= 1) return -2;
      return 0;
    }

    // Heuristic 17: Emoji Bullet Spam
    // AI posts often use the same emoji as bullet points for 3+ lines
    checkEmojiPointers(text) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      // Match lines starting with an emoji (common pointer emojis)
      const emojiLinePattern = /^([\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{2702}-\u{27B0}])/u;
      const emojiCounts = {};
      for (const line of lines) {
        const match = line.match(emojiLinePattern);
        if (match) {
          const emoji = match[1];
          emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
        }
      }
      const maxCount = Math.max(0, ...Object.values(emojiCounts));
      if (maxCount >= 4) return -5;
      if (maxCount >= 3) return -3;
      return 0;
    }

    mapScoreToLevel(score) {
      // 2-level system: Human or Slop
      // Be decisive - no "maybe"
      if (score >= -4) return 2;  // Human
      return 1;                   // Slop
    }

    extractAuthorName(post) {
      // Try to find the author name in various LinkedIn post structures
      // LinkedIn 2024/2025 DOM structure - be very specific to avoid picking up wrong text
      const nameSelectors = [
        // Primary: the actor name container with nested spans
        '.update-components-actor__name .hoverable-link-text span[aria-hidden="true"]',
        '.update-components-actor__name span[aria-hidden="true"]',
        '.update-components-actor__title span[aria-hidden="true"]',
        // Feed shared structure
        '.feed-shared-actor__name span[aria-hidden="true"]',
        // Fallback to the link itself
        '.update-components-actor__name a',
        '.feed-shared-actor__name a'
      ];

      for (const selector of nameSelectors) {
        const nameEl = post.querySelector(selector);
        if (nameEl && nameEl.textContent) {
          const fullName = nameEl.textContent.trim();
          // Skip if it looks like non-name content
          if (fullName.length < 2 || fullName.length > 50) continue;
          if (/^(Exciting|Sponsored|Promoted|Follow|Connect|\d)/i.test(fullName)) continue;
          // Extract first name (before first space)
          const firstName = fullName.split(' ')[0];
          // Validate it looks like a name (starts with capital, reasonable length)
          if (firstName.length >= 2 && firstName.length <= 20 && /^[A-Z]/.test(firstName)) {
            return firstName;
          }
        }
      }

      return 'the author'; // Fallback - reads better in sentences
    }

    generateCommentary(breakdown, level, authorName) {
      // Sort breakdown by most negative (most suspicious)
      const factors = [];
      for (const [key, value] of Object.entries(breakdown)) {
        if (value < 0) {
          factors.push({ name: key, score: value });
        }
      }
      factors.sort((a, b) => a.score - b.score);

      // More descriptive, varied names for each heuristic
      const factorNames = {
        vocab: ['AI buzzwords', 'telltale AI words', 'robot vocabulary', 'AI-speak'],
        grandiose: ['puffed-up language', 'grandiose claims', 'over-the-top prose'],
        ruleOfThree: ['the classic rule of three', 'triplet pattern', 'three-part lists'],
        participle: ['"-ing" clause overload', 'dangling modifiers', 'participle padding'],
        editorial: ['unnecessary commentary', '"importantly" spam', 'editorial asides'],
        transitions: ['transition word soup', 'moreover/furthermore abuse', 'connector overload'],
        parallelNegation: ['parallel negation tricks', '"not X, but Y" pattern', 'negation structure'],
        sentenceRhythm: ['choppy paragraph rhythm', 'one-sentence paragraphs', 'robotic cadence'],
        listParallelism: ['too-perfect lists', 'identical list structure', 'parallel list items'],
        colonLists: ['colon-list combos', '"here\'s what:" pattern', 'setup-list structure'],
        emDash: ['dramatic em dashes', 'spaced em dashes', '— pause abuse —'],
        staccato: ['staccato line breaks', 'dramatic one-liners', 'punchy fragments'],
        metaphors: ['tired business clichés', 'overused metaphors', 'corporate speak'],
        engagementBait: ['engagement bait', '"what do you think?"', 'comment-fishing'],
        curlyQuotes: ['curly smart quotes', 'ChatGPT-style quotes', 'fancy quotation marks'],
        promotional: ['marketing speak', 'press-release tone', 'promotional language'],
        emojiPointers: ['emoji bullet spam', 'emoji list padding', 'repeated emoji bullets']
      };

      // Pick a random variant for variety
      const getFactorName = (key) => {
        const variants = factorNames[key];
        if (Array.isArray(variants)) {
          return variants[Math.floor(Math.random() * variants.length)];
        }
        return key;
      };

      // Friendly Detective personality
      if (level === 1) {
        // SLOP - AI detected
        const top3 = factors.slice(0, 3).map(f => getFactorName(f.name));
        const templates = [
          `Elementary! The evidence points to AI: ${top3.join(', ')}.`,
          `The clues don't lie: ${top3.join(', ')}. That's AI.`,
          `Investigating... AI confirmed. Signals: ${top3.join(', ')}.`,
          `AI detected. The tells? ${top3.join(', ')}.`,
          `Case closed: ${top3.join(', ')} = AI writing.`
        ];
        return templates[Math.floor(Math.random() * templates.length)];
      } else {
        // HUMAN - authentic content
        if (factors.length === 0) {
          const templates = [
            `Looks human to me! No AI fingerprints detected.`,
            `Elementary! This one's authentic. Clean as a whistle.`,
            `Case closed: genuine human writing. Zero AI tells.`,
            `All clear here. Not a single red flag.`
          ];
          return templates[Math.floor(Math.random() * templates.length)];
        } else if (factors.length <= 2) {
          const factorList = factors.map(f => getFactorName(f.name)).join(', ');
          const templates = [
            `Looks human. Minor signals (${factorList}) but well below threshold.`,
            `Probably authentic. Slight traces of ${factorList}, but nothing suspicious.`,
            `Passes the human test. Detected ${factorList}, but the voice is genuine.`
          ];
          return templates[Math.floor(Math.random() * templates.length)];
        } else {
          const factorList = factors.slice(0, 2).map(f => getFactorName(f.name)).join(', ');
          const templates = [
            `Likely authentic. Some patterns (${factorList}) but not enough to convict.`,
            `Human verdict. ${factorList} noted, but passes the test.`,
            `Genuine content. ${factorList} present, but inconclusive.`
          ];
          return templates[Math.floor(Math.random() * templates.length)];
        }
      }
    }

    injectBadge(post, level, commentary) {
      if (post.querySelector('.slop-detector-badge')) return;

      const badge = document.createElement('div');
      badge.className = 'slop-detector-badge';
      badge.setAttribute('data-level', level);

      // Build badge content
      const content = document.createElement('div');
      content.className = 'slop-badge-content';

      // Icon (emoji indicator)
      const icon = document.createElement('div');
      icon.className = 'slop-icon';
      icon.textContent = level === 1 ? '🤖' : '✍️';

      // Label
      const label = document.createElement('div');
      label.className = 'slop-label';
      label.textContent = this.getLabelText(level);

      // Commentary
      const commentaryEl = document.createElement('div');
      commentaryEl.className = 'slop-commentary';
      commentaryEl.textContent = commentary;

      content.appendChild(icon);
      content.appendChild(label);
      content.appendChild(commentaryEl);
      badge.appendChild(content);

      // Create a sticky container positioned to the left
      const postRect = post.getBoundingClientRect();
      const spaceOnLeft = postRect.left;

      // Only position outside if there's enough space (220px for badge + margin)
      const canPositionOutside = spaceOnLeft >= 220;

      const stickyContainer = document.createElement('div');
      if (canPositionOutside) {
        stickyContainer.style.cssText = `
          position: absolute;
          left: -215px;
          top: 0;
          width: 200px;
          height: 100%;
        `;
      } else {
        // Fall back to top-right corner inside the post
        stickyContainer.style.cssText = `
          position: absolute;
          right: 8px;
          top: 8px;
          width: 180px;
          z-index: 1000;
        `;
      }

      badge.style.cssText = `
        position: sticky;
        top: 80px;
        z-index: 1000;
      `;

      stickyContainer.appendChild(badge);
      post.style.position = 'relative';
      post.appendChild(stickyContainer);

      // Auto-block slop posts if setting is enabled
      if (level === 1 && this.blockSlop) {
        this.blockPost(post);
      }

      // After injecting badge, scan comments on this post
      this.scanCommentsOnPost(post);
    }

    blockPost(post) {
      if (post.dataset.slopBlocked) return;
      post.dataset.slopBlocked = 'true';
      post.style.display = 'none';
    }

    unblockPost(post) {
      if (!post.dataset.slopBlocked) return;
      delete post.dataset.slopBlocked;
      post.style.display = '';
    }

    // Apply block setting to all already-analyzed posts
    applyBlockSetting() {
      if (this.blockSlop) {
        // Find all level-1 (slop) posts by badge
        const slopPosts = document.querySelectorAll('[data-urn*="urn:li:activity"]');
        slopPosts.forEach(post => {
          const badge = post.querySelector('.slop-detector-badge[data-level="1"]');
          if (badge) this.blockPost(post);
        });
      } else {
        // Unblock all blocked posts
        const blockedPosts = document.querySelectorAll('[data-slop-blocked]');
        blockedPosts.forEach(post => this.unblockPost(post));
      }
    }

    // ========================================
    // COMMENT SCANNING
    // Detects AI-generated comments ("reply guys")
    // ========================================

    scanCommentsOnPost(post) {
      const commentSelectors = [
        '.comments-comment-item',
        '.comments-comment-entity',
        '[data-test-id*="comment"]',
        '[id*="comment-"]',
        '.feed-shared-update-v2__comments-container .artdeco-card'
      ];

      for (const selector of commentSelectors) {
        const comments = post.querySelectorAll(selector);
        comments.forEach(comment => this.analyzeComment(comment));
      }

      // Comment observation is handled by the single delegated observer in _observeComments()
    }

    analyzeComment(comment) {
      if (comment.dataset.slopAnalyzed) return;
      comment.dataset.slopAnalyzed = 'true';

      // Extract comment text
      const textEl = comment.querySelector(
        '.comments-comment-item__main-content, ' +
        '.update-components-text, ' +
        '[class*="comment-item__inline-show-more-text"], ' +
        '[class*="comment__content"], ' +
        'span[dir="ltr"]'
      );
      if (!textEl) return;

      let text = textEl.innerText || textEl.textContent || '';
      text = text.trim();
      if (text.length < 20) return;

      // Run a lighter version of scoring tuned for short comments
      const { score, breakdown } = this.scoreComment(text);

      if (score <= -4) {
        // High confidence AI comment - add reply guy label
        comment.classList.add('slop-reply-guy');

        const tag = document.createElement('span');
        tag.className = 'slop-reply-guy-tag';
        tag.textContent = 'Reply Guy 🤖';
        tag.title = this.getCommentTooltip(breakdown);

        // Insert tag near the commenter name
        const nameEl = comment.querySelector(
          '.comments-post-meta__name-text, ' +
          '[class*="comment-actor"], ' +
          '.comment-entity__actor, ' +
          'a[class*="actor"], ' +
          'a[href*="/in/"]'
        );
        if (nameEl && !nameEl.parentElement.querySelector('.slop-reply-guy-tag')) {
          nameEl.parentElement.insertBefore(tag, nameEl.nextSibling);
        } else if (!comment.querySelector('.slop-reply-guy-tag')) {
          comment.insertBefore(tag, comment.firstChild);
        }
      }
    }

    scoreComment(text) {
      const breakdown = {};
      let score = 0;

      // Use a subset of heuristics tuned for short comments
      breakdown.vocab = this.checkAIVocabulary(text);
      score += breakdown.vocab;

      breakdown.grandiose = this.checkGrandioseLanguage(text);
      score += breakdown.grandiose;

      breakdown.participle = this.checkParticipleTrailers(text);
      score += breakdown.participle;

      breakdown.editorial = this.checkEditorialCommentary(text);
      score += breakdown.editorial;

      breakdown.emDash = this.checkEmDashSpacing(text);
      score += breakdown.emDash;

      breakdown.curlyQuotes = this.checkCurlyQuotes(text);
      score += breakdown.curlyQuotes;

      breakdown.promotional = this.checkPromotionalTone(text);
      score += breakdown.promotional;

      breakdown.engagementBait = this.checkEngagementBait(text);
      score += breakdown.engagementBait;

      breakdown.emojiPointers = this.checkEmojiPointers(text);
      score += breakdown.emojiPointers;

      return { score, breakdown };
    }

    getCommentTooltip(breakdown) {
      const factorNames = {
        vocab: 'AI buzzwords',
        grandiose: 'grandiose language',
        participle: 'participle padding',
        editorial: 'editorial commentary',
        emDash: 'em dash abuse',
        curlyQuotes: 'smart quotes',
        promotional: 'promotional tone',
        engagementBait: 'engagement bait',
        emojiPointers: 'emoji bullet spam'
      };

      const signals = Object.entries(breakdown)
        .filter(([, v]) => v < 0)
        .map(([k]) => factorNames[k] || k);

      return signals.length > 0
        ? `AI signals: ${signals.join(', ')}`
        : 'Likely AI-generated comment';
    }

    getLabelText(level) {
      const labels = {
        1: 'Slop',
        2: 'Human'
      };
      return labels[level] || '';
    }

    saveStats() {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.set({ slopStats: this.stats });
        }
      } catch (e) {
        // Ignore storage errors
      }
    }
  }

  // Initialize
  new SlopDetector();
})();
