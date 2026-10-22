const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: { message: 'GROQ_API_KEY is not set. Add it under Vercel Project Settings > Environment Variables.' },
    });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');

    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        // Groq's CDN blocks default server user agents
        'User-Agent': 'SmartMed/1.0',
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body,
    });

    const payload = await upstream.text();
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      json = { error: { message: 'Groq returned HTTP ' + upstream.status + ': ' + payload.slice(0, 200) } };
    }
    return res.status(upstream.status).json(json);
  } catch (err) {
    return res.status(502).json({ error: { message: 'Cannot reach Groq: ' + (err && err.message) } });
  }
};
