// Local / Docker entry point. (On Vercel, api/index.js is used instead.)
require('./app').listen(process.env.PORT || 3000, () => console.log('chorebored running 🏡'));
