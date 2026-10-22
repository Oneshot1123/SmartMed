/*
 * Groq-powered plain-language explainer for the Today tab.
 *
 * Calls go through the local proxy (serve.py -> /api/groq) so the API key lives
 * only in .env, never in the browser. Each explanation is per patient: the
 * caller passes that patient's precomputed stats and the answer is cached in
 * memory for the session until the patient is switched or re-explained.
 *
 * Public API:
 *   SmedLLM.explain(patientID, stats) -> Promise<string>
 *     Rejects with {title, hint} so the UI can show a friendly message.
 *   SmedLLM.clear() -> forget the cached answers (patient switched / signed out)
 *   SmedLLM.groqAvailable() -> true once the proxy answered at least once
 */
window.SmedLLM = (function () {
  'use strict';

  var MODEL = 'openai/gpt-oss-20b';
  var ENDPOINT = '/api/groq';
  var cache = {}; // patientID -> answer text

  var SYSTEM_PROMPT =
    'You explain medication-adherence data to a family caregiver who is not medical or technical. ' +
    'Use ONLY the statistics in the user message; never invent numbers, medical facts or suggestions. ' +
    'Definitions to respect: "taken" means the box recorded the medicine at all; "on time" means it was opened within one hour of the set time. ' +
    'Never say "missed on time" or merge the two percentages. ' +
    'Answer in at most 3 short sentences of simple everyday English, no bullet points, no headings. ' +
    'If the data is missing or the device has gone quiet, say it plainly. ' +
    'If the week looks fine, say so gently, do not invent a problem.';

  function toText(json) {
    var choice = json && json.choices && json.choices[0];
    var text = choice && choice.message && choice.message.content;
    return typeof text === 'string' ? text.trim() : '';
  }

  function explain(patientID, stats) {
    if (cache[patientID]) return Promise.resolve(cache[patientID]);
    if (!stats) {
      return Promise.reject({ title: 'No data yet', hint: 'Add a medicine and record a few doses first.' });
    }

    var payload = {
      model: MODEL,
      temperature: 0.4,
      // gpt-oss spends some tokens on hidden reasoning before answering
      max_tokens: 900,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Patient: ' + stats.patient + '\n' +
            'Explain this week using these statistics:\n' +
            JSON.stringify(stats)
        }
      ]
    };

    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (resp) {
      return resp.text().then(function (raw) {
        if (resp.status === 404 || resp.status === 501 || raw.charAt(0) === '<') {
          // Plain http.server answers POSTs (501/404) with an HTML error page
          return Promise.reject({
            title: 'AI helper not connected',
            hint: 'Run the app with: python serve.py 8000 (plain http.server has no AI proxy).'
          });
        }
        var json;
        try {
          json = JSON.parse(raw);
        } catch (e) {
          return Promise.reject({ title: 'Unexpected reply', hint: 'The server did not return JSON. Is it serve.py?' });
        }
        var text = toText(json);
        if (json && json.error) {
          return Promise.reject({ title: 'Groq error', hint: json.error.message || 'Request failed.' });
        }
        if (!text) {
          return Promise.reject({ title: 'Empty answer', hint: 'Groq returned nothing. Try again.' });
        }
        cache[patientID] = text;
        return text;
      });
    });
  }

  function forget(patientID) {
    delete cache[patientID];
  }

  function clear() {
    Object.keys(cache).forEach(function (k) { delete cache[k]; });
  }

  return { explain: explain, forget: forget, clear: clear };
})();
