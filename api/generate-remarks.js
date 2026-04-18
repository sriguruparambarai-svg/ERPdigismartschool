// DigiSmart ERP — Vercel Serverless API Function
// File: api/generate-remarks.js
//
// This function runs on Vercel's server (not in the browser).
// The Anthropic API key is stored safely in Vercel environment variables.
// The browser calls /api/generate-remarks instead of calling Anthropic directly.
// This way the key is NEVER visible to anyone.

export default async function handler(req, res) {

  // Allow requests from your domain only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get prompt from request
  const { prompt, type } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Check API key is configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Please add ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 250,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Anthropic API error: ' + errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || 'Good effort! Keep working hard and aim higher next time.';

    return res.status(200).json({ remark: text });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      error: 'Failed to generate remark',
      remark: 'Good effort! Keep working hard and aim higher next time.'
    });
  }
}
