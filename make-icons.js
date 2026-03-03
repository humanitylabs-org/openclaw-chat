// Simple icon generator using sharp
const fs = require('fs');

// Create a simple SVG icon
const createSVG = (size) => `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#4f46e5;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#grad)" rx="${size * 0.1}"/>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="${size * 0.6}" text-anchor="middle" dominant-baseline="central" fill="#ffffff">🤖</text>
</svg>
`;

// Try using sharp if available, otherwise just save SVG
try {
  const sharp = require('sharp');
  
  // Generate 192x192
  sharp(Buffer.from(createSVG(192)))
    .png()
    .toFile('icon-192.png')
    .then(() => console.log('Created icon-192.png'))
    .catch(err => console.error('Error creating icon-192:', err));

  // Generate 512x512
  sharp(Buffer.from(createSVG(512)))
    .png()
    .toFile('icon-512.png')
    .then(() => console.log('Created icon-512.png'))
    .catch(err => console.error('Error creating icon-512:', err));

} catch (e) {
  console.log('sharp not available, creating SVG fallbacks');
  
  // Just save SVGs as fallback
  fs.writeFileSync('icon-192.svg', createSVG(192));
  fs.writeFileSync('icon-512.svg', createSVG(512));
  console.log('Created SVG icons (install sharp for PNG: npm install sharp)');
}
