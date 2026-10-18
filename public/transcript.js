// Builds the assistant's chat text from Telnyx transcript frames.
//
// Observed on real conversations: Telnyx sends two interleaved streams as
// `response.output_audio_transcript.delta`, with the same response_id/item_id:
//   1. LLM text — long chunks or chunks cut mid-word ("…per F", "avign");
//      some chunks never arrive, so on its own it reads "Favignici";
//   2. spoken words — one or two whole words with a leading space, paced with
//      the audio (" Perfetto,", " dieci al"); occasionally a word is missing.
// Concatenating both gave duplicated, scrambled text. Instead we keep the two
// streams apart and align them word by word (LCS): where they agree we keep the
// text, where only one has words we take them (filling the other's gap), and
// where they disagree we trust the spoken words.
// Exposed as window.TranscriptMerge (and testable under Node).
(function (root) {
  const WORD_CHUNK = /^\s\S+(?:\s\S+)?$/;    // " word" or " two words"
  const FRAGMENT = /^\s[a-zà-ÿ]{1,3}$/i;      // " qu" — looks like a word, is a cut-off LLM chunk

  const isWordChunk = (d) => WORD_CHUNK.test(d) && d.length <= 32;
  const key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = (s) => s.split(/\s+/).filter(Boolean);

  // live=true: stop at the last spoken word, so text that is still ahead of the
  // voice (and may hold cut-off LLM chunks) isn't shown yet.
  function align(llm, spoken, live = false) {
    const L = tokens(llm), W = tokens(spoken);
    if (!W.length) return L;
    if (!L.length) return W;
    const n = L.length, m = W.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = key(L[i]) && key(L[i]) === key(W[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let spokenEnd = 0; // out.length after the last token backed by the spoken stream
    let onlyL = [], onlyW = [];
    // " ott", " qu": short cut-off LLM chunks that look like spoken words.
    const fragmentsOnly = (ts) => ts.every((t) => /^[a-zà-ÿ]{1,3}$/i.test(t));
    const flush = () => {
      if (onlyW.length && !(onlyL.length && fragmentsOnly(onlyW))) { out.push(...onlyW); spokenEnd = out.length; } // disagreement or LLM gap → spoken words
      else out.push(...onlyL);                                                                                  // spoken gap/fragment → LLM words
      onlyL = []; onlyW = [];
    };
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && key(L[i]) && key(L[i]) === key(W[j])) {
        flush();
        out.push(W[j]);
        spokenEnd = out.length;
        i++; j++;
      } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
        onlyL.push(L[i++]);
      } else {
        onlyW.push(W[j++]);
      }
    }
    if (live) return (flush(), out.slice(0, spokenEnd));
    flush();
    return out;
  }

  function createAssembler() {
    let llm = "";
    let words = "";
    let lastWasWord = false, lastWord = "";
    return {
      add(delta) {
        if (!delta) return;
        if (isWordChunk(delta)) {
          words += delta;
          lastWasWord = true;
          lastWord = delta;
          return;
        }
        // An LLM chunk continuing mid-word ("ici …") means the short "word" just
        // before it (" qu") was really an LLM fragment: move it back.
        if (lastWasWord && /^[^\s]/.test(delta) && FRAGMENT.test(lastWord)) {
          words = words.slice(0, -lastWord.length);
          llm += lastWord;
        }
        llm += delta;
        lastWasWord = false;
      },
      // live: while the response is still being spoken; final: once it's done.
      text({ live = false } = {}) {
        if (live && !words) {
          // Nothing spoken yet: show the LLM text without a trailing half word ("…per F").
          const ts = tokens(llm);
          if (/\S$/.test(llm) && !/[.,!?;:]$/.test(llm)) ts.pop();
          return ts.join(" ");
        }
        return align(llm, words, live).join(" ");
      },
    };
  }

  root.TranscriptMerge = { createAssembler };
})(typeof window !== "undefined" ? window : globalThis);
