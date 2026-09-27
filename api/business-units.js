'use strict';
const { BUS, json, cors } = require('../lib/core');

module.exports = (req, res) => {
  if (cors(req, res)) return;
  return json(res, 200, { businessUnits: BUS });
};
