module.exports = (puppeteerPage, cookies) => {
  await cookies.forEach(async (cookie) => {
    await puppeteerPage.setCookie(cookie);
  });

  return page;
};
