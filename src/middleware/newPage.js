const puppeteer = require('puppeteer');

module.exports = async () => {
  const browser = await puppeteer.launch();
  return await browser.newPage();
};
