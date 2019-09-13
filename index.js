// crawler
const puppeteer = require("puppeteer");
const elasticsearch = require("elasticsearch");
const cheerio = require("cheerio");
const fs = require("fs");
const urlParser = require("url-parse");
const hash = require("string-hash");

let toVisit = [];
const visitedLinks = [];

let timer;

const client = new elasticsearch.Client({
  host: "localhost:9200",
  log: [
    {
      type: "stdio",
      levels: ["error"]
    }
  ]
});

const storeDocument = async (id, body) => {
  await client.index({
    index: "cars",
    type: "car",
    id: id,
    body: {
      ...body,
      unique_ad_hash: `${hash(`${body.mileage}-${body.year}-${body.price}`)}`
    }
  });
};

const timeout = ms => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const sanitizeString = string => string.replace(/(\r\n\t|\n|\r\t)/gm, " ");

const processHTMLMP = async (html, meta) => {
  const $ = cheerio.load(html);
  console.log("Number of pages:", $(".pagination-pages a").length);
  const make = $('.mp-Chip[data-parent-id="91"]')
    .text()
    .trim();
  let model = "";

  $(".mp-Chip").each((i, filterHTML) => {
    const filterText = $(filterHTML).text();
    if (filterText.indexOf("Model:") !== -1) {
      model = filterText.replace("Model:", "").trim();
    }
  });

  $(".search-result").each(async (i, resultHTML) => {
    const $result = $(resultHTML);
    let url = ($result.attr("data-url") || "").trim();

    if (!url) {
      // Marktplaats ad! Skip it!
      return;
    }

    const parsedUrl = urlParser(url, true);
    url = `${parsedUrl.origin}${parsedUrl.pathname}`;

    const priceRegex = /^€\s(\d*.?\d*)/g;
    const nonDigit = /[^\d]/g;

    const priceMatch = priceRegex.exec(
      $result
        .find(".price-new")
        .text()
        .trim()
    );
    const price = parseInt(
      priceMatch !== null && priceMatch.length >= 2
        ? priceMatch[1].replace(nonDigit, "")
        : 0,
      10
    );

    if (price <= 0) {
      // No price or even smaller then zero!? Nonsense for our app. Gone be it!
      return;
    }

    const allPostInfo = {
      title: sanitizeString($result.find(".mp-listing-title").text()),
      price,
      year: parseInt($result.find(".mp-listing-attributes.first").text(), 10),
      mileage: parseInt(
        $result
          .find(".mp-listing-attributes")
          .eq(1)
          .text()
          .replace(nonDigit, ""),
        10
      ),
      make: sanitizeString(make),
      model: sanitizeString(model),
      url: url,
      ...meta
    };

    if (isNaN(allPostInfo.mileage) || allPostInfo.mileage === 0) {
      // No mileage? plz no!
      return;
    }

    await storeDocument(url, allPostInfo);
  });

  const links = $(".pagination-pages a").each((i, linkHTML) => {
    const link = linkHTML.attribs.href.trim();

    const inVisited = visitedLinks.indexOf(link) > -1;
    const inToVisit =
      toVisit.filter(linkObj => linkObj.url === link).length !== 0;

    if (!inVisited && !inToVisit) {
      toVisit.push({
        url: link,
        parser: "marktplaats",
        meta: {
          origin: "marktplaats"
        }
      });
    }
  });
};

const processHTMLGP = async (html, meta) => {
  const $ = cheerio.load(html);
  console.log(
    "Number of pages:",
    $(".pagination a").not(".pagination__link--current").length
  );
  const makeMatch = /^(.*)\s\(.*$/g.exec(
    $("#merk .text")
      .text()
      .trim()
  );
  const make = makeMatch !== null ? makeMatch[1] : "";

  const modelMatch = /^(.*)\s\(.*$/g.exec(
    $("#model .text")
      .text()
      .trim()
  );
  const model = modelMatch !== null ? modelMatch[1] : "";

  $("li.occasion").each(async (i, resultHTML) => {
    const $result = $(resultHTML);
    let url = $result.find("a").attr("href");

    const parsedUrl = urlParser(url, true);
    url = `${parsedUrl.origin}${parsedUrl.pathname}`;

    const priceRegex = /^€\s(\d*.?\d*)/g;
    const nonDigit = /[^\d]/g;
    const yearMileageRegex = /^Bouwjaar:\s(\d*),\sKm.stand:[\\n]*\s*(\d*.?\d*)\skm$/g;

    const priceMatch = priceRegex.exec(
      $result
        .find(".occ_price")
        .text()
        .trim()
    );
    const price = parseInt(
      priceMatch !== null ? priceMatch[1].replace(nonDigit, "") : 0,
      10
    );
    const yearMileageMatch = yearMileageRegex.exec(
      $result
        .find(".occ_bouwjaar_kmstand")
        .text()
        .trim()
    );

    if (price <= 0) {
      // No price or even smaller then zero!? Nonsense for our app. Gone be it!
      return;
    }

    const allPostInfo = {
      title: sanitizeString(
        $result
          .find(".occ_cartitle")
          .text()
          .trim()
      ),
      price,
      year: parseInt(
        yearMileageMatch !== null
          ? yearMileageMatch[1].replace(nonDigit, "")
          : 0,
        10
      ),
      mileage: parseInt(
        yearMileageMatch !== null
          ? yearMileageMatch[2].replace(nonDigit, "")
          : 0,
        10
      ),
      make: sanitizeString(make),
      model: sanitizeString(model),
      url: url,
      ...meta
    };

    if (allPostInfo.mileage === 0) {
      // No mileage gives unexpected results. Gone be it.
      return;
    }
    await storeDocument(url, allPostInfo);
  });

  const links = $(".pagination a")
    .not(".pagination__link--current")
    .each((i, linkHTML) => {
      const link = linkHTML.attribs.href.trim();

      const inVisited = visitedLinks.indexOf(link) > -1;
      const inToVisit =
        toVisit.filter(linkObj => linkObj.url === link).length !== 0;

      if (!inVisited && !inToVisit) {
        toVisit.push({
          url: link,
          parser: "gaspedaal",
          meta: {
            origin: "gaspedaal"
          }
        });
      }
    });
};

const processHTMLAS = async (html, meta) => {
  const $ = cheerio.load(html);
  console.log(
    "Number of pages:",
    $(".cl-pagination .sc-pagination a").not(".active").length
  );
  const stripParensRegExp = /^(.*)\s\(.*$/g;
  const make = $('div[data-test="make0"] input').val();
  const model = $('div[data-test="modelmodelline0"] input').val();

  $(".cldt-summary-full-item").each(async (i, resultHTML) => {
    const $result = $(resultHTML);
    let url = `https://www.autoscout24.nl/${$result
      .find('a[data-item-name="detail-page-link"]')
      .attr("href")
      .trim()}`;

    const parsedUrl = urlParser(url, true);
    url = `${parsedUrl.origin}${parsedUrl.pathname}`;

    const priceRegex = /^€\s(\d*.?\d*)/g;
    const nonDigit = /[^\d]/g;
    const yearRegex = /^\d*\/(\d*)/g;

    const priceMatch = priceRegex.exec(
      $result
        .find(".cldt-price")
        .text()
        .trim()
    );
    const price = parseInt(
      priceMatch !== null ? priceMatch[1].replace(nonDigit, "") : 0,
      10
    );
    const yearMatch = yearRegex.exec(
      $result
        .find(".cldt-summary-vehicle-data li")
        .eq(1)
        .text()
        .trim()
    );

    if (price <= 0) {
      // No price or even smaller then zero!? Nonsense for our app. Gone be it!
      return;
    }

    const allPostInfo = {
      title: sanitizeString(
        $result
          .find(".cldt-summary-title")
          .text()
          .trim()
      ),
      price,
      year: parseInt(
        yearMatch !== null ? yearMatch[1].replace(nonDigit, "") : 0,
        10
      ),
      mileage: parseInt(
        $result
          .find(".cldt-summary-vehicle-data li")
          .eq(0)
          .text()
          .replace(nonDigit, ""),
        10
      ),
      make: sanitizeString(make),
      model: sanitizeString(model),
      url: url,
      ...meta
    };

    if (allPostInfo.mileage === 0 || isNaN(allPostInfo.mileage)) {
      return;
    }

    await storeDocument(url, allPostInfo);
  });

  // retrieve canonical to build correct url
  const canonical = $('link[rel="canonical"]').attr("href");

  const links = $(".cl-pagination .sc-pagination a")
    .not(".active")
    .each((i, linkHTML) => {
      if (!linkHTML.attribs.href) {
        return;
      }

      let link = linkHTML.attribs.href.trim();

      if (!link.startsWith("https://www.autoscout24.nl")) {
        link = `${canonical}${link}`;
      }

      const inVisited = visitedLinks.indexOf(link) > -1;
      const inToVisit =
        toVisit.filter(linkObj => linkObj.url === link).length !== 0;

      if (link)
        if (!inVisited && !inToVisit) {
          toVisit.push({
            url: link,
            parser: "autoscout",
            meta: {
              origin: "autoscout"
            }
          });
        }
    });
};

const requestPageMP = async (url, meta) => {
  // Would be nice to use streams / observable for this!
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setCookie({
    name: "CookieOptIn",
    value: "true",
    domain: ".marktplaats.nl",
    path: "/"
  });

  console.log("Visited:", visitedLinks);
  console.log("Requesting:", url);

  await page.goto(url);
  visitedLinks.push(url);
  const html = await page.content();
  await browser.close();
  await processHTMLMP(html, meta);
};

const requestPageGP = async (url, meta) => {
  // Would be nice to use streams / observable for this!
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setCookie({
    name: "CookieConsent",
    value: "1",
    domain: ".www.gaspedaal.nl",
    path: "/"
  });
  await page.setCookie({
    name: "firstVisit",
    value: "1",
    domain: ".www.gaspedaal.nl",
    path: "/"
  });

  console.log("Visited:", visitedLinks);
  console.log("Requesting:", url);

  await page.goto(url);
  visitedLinks.push(url);
  const html = await page.content();
  await browser.close();
  await processHTMLGP(html, meta);
};

const requestPageAS = async (url, meta) => {
  // Would be nice to use streams / observable for this!
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setCookie({
    name: "cookieConsent",
    value: "1",
    domain: ".autoscout24.nl",
    path: "/"
  });

  console.log("Visited:", visitedLinks);
  console.log("Requesting:", url);

  await page.goto(url);
  visitedLinks.push(url);
  const html = await page.content();
  await browser.close();
  await processHTMLAS(html, meta);
};

const startCrawl = ({ url, parser, meta }) => {
  switch (parser) {
    case "marktplaats": {
      return requestPageMP(url, meta);
    }
    case "gaspedaal": {
      return requestPageGP(url, meta);
    }
    case "autoscout": {
      return requestPageAS(url, meta);
    }
  }
};

timer = setInterval(async () => {
  if (toVisit.length === 0) {
    clearInterval(timer);
    return;
  }

  console.log("To visit:", toVisit);
  const [urlObject, ...rest] = toVisit;
  toVisit = rest;

  await timeout(Math.random() * 2000);
  await startCrawl(urlObject);
}, 10000);

// Nissan Pixo: Marktplaats
toVisit.push({
  url:
    "https://www.marktplaats.nl/z.html?categoryId=135&attributes=model%2CPixo&startDateFrom=ALWAYS&priceFrom=&priceTo=&attributes=priceType%2CVraagprijs&yearFrom=2010&yearTo=2010&mileageFrom=&mileageTo=&attributes=&query=&searchOnTitleAndDescription=true&postcode=3812JA&distance=0&attributes=fuel%2CBenzine&attributes=options%2CClimate_control_Airconditioning",
  parser: "marktplaats",
  meta: {
    origin: "marktplaats"
  }
});

// Nissan Pixo: Gaspedaal
toVisit.push({
  url:
    "https://www.gaspedaal.nl/nissan/pixo/benzine?bmax=2010&bmin=2010&opt=38&srt=df-a",
  parser: "gaspedaal",
  meta: {
    origin: "gaspedaal"
  }
});

// Nissan Pixo: Autoscout24
toVisit.push({
  url:
    "https://www.autoscout24.nl/lst/nissan/pixo?sort=standard&desc=0&eq=5&offer=J%2CU%2CO%2CD&fuel=B&ustate=N%2CU&cy=NL&atype=C",
  parser: "autoscout",
  meta: {
    origin: "autoscout"
  }
});
