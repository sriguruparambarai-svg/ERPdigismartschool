// DigiSmart ERP — Face Recognition API
// Uses Anthropic Vision to compare staff faces
// No model files needed — works on any internet connection

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { livePhoto, enrolledStaff } = req.body;
  // livePhoto: base64 image from camera
  // enrolledStaff: [{id, name, role, photo: base64}]

  if (!livePhoto || !enrolledStaff || enrolledStaff.length === 0) {
    return res.status(400).json({ error: 'Missing photo or staff data' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Build message with live photo + all enrolled photos
    const content = [
      {
        type: 'text',
        text: `I will show you a live camera photo followed by ${enrolledStaff.length} enrolled staff photos. 
Tell me which enrolled staff member matches the live photo.
Reply with ONLY the staff ID number, nothing else. 
If no match is found, reply with: NOMATCH
Enrolled staff: ${enrolledStaff.map((s,i) => `[${i+1}] ID:${s.id} Name:${s.name}`).join(', ')}`
      },
      {
        type: 'text',
        text: 'LIVE CAMERA PHOTO:'
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: livePhoto }
      },
      { type: 'text', text: 'ENROLLED STAFF PHOTOS:' },
      ...enrolledStaff.flatMap((s, i) => [
        { type: 'text', text: `[${i+1}] ${s.name}:` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.photo } }
      ])
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 50,
        messages: [{ role: 'user', content }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'API error: ' + err });
    }

    const data = await response.json();
    const answer = (data.content?.[0]?.text || 'NOMATCH').trim();

    if (answer === 'NOMATCH') {
      return res.status(200).json({ matched: false });
    }

    // Find the matched staff
    const matched = enrolledStaff.find(s => s.id === answer);
    if (matched) {
      return res.status(200).json({ matched: true, staffId: matched.id, staffName: matched.name, staffRole: matched.role });
    }

    return res.status(200).json({ matched: false });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
