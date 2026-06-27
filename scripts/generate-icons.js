// Simple script to create placeholder PWA icons
// Run with: node scripts/generate-icons.js

const fs = require('fs');
const path = require('path');

// Create SVG icons that can be used as placeholders
const createSVGIcon = (size) => {
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#9333ea"/>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="${size * 0.4}" fill="white" text-anchor="middle" dominant-baseline="middle" font-weight="bold">P</text>
</svg>`;
};

// Create public directory if it doesn't exist
const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Generate 192x192 icon
fs.writeFileSync(
  path.join(publicDir, 'icon-192.svg'),
  createSVGIcon(192)
);

// Generate 512x512 icon
fs.writeFileSync(
  path.join(publicDir, 'icon-512.svg'),
  createSVGIcon(512)
);

console.log('✅ SVG icons generated successfully!');
console.log('📝 Note: For production, replace these with proper PNG icons.');
console.log('   You can use tools like:');
console.log('   - https://realfavicongenerator.net/');
console.log('   - https://www.pwabuilder.com/imageGenerator');

// Made with Bob
