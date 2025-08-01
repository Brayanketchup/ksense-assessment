const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://assessment.ksensetech.com/api';
const HEADERS = { 'x-api-key': API_KEY };

const MAX_RETRIES = 5;
const highRisk = [];
const feverPatients = [];
const dataIssues = [];

function parseBloodPressure(bp) {
    if (!bp || typeof bp !== 'string' || !bp.includes('/')) return [null, null];
    
    const [sys, dia] = bp.split('/');

    const systolic = /^\d+$/.test(sys) ? parseInt(sys) : null;
    const diastolic = /^\d+$/.test(dia) ? parseInt(dia) : null;
    return [systolic, diastolic];
}

function bpScore(systolic, diastolic) {
    if (systolic == null || diastolic == null) return 0;
    if (systolic < 120 && diastolic < 80) return 1;
    if (systolic >= 120 && systolic <= 129 && diastolic < 80) return 2;
    if ((systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89)) return 3;
    if (systolic >= 140 || diastolic >= 90) return 4;
    return 0;
}

function tempScore(temp) {

    const t = parseFloat(temp);
    if (isNaN(t)) return 0;
    if (t <= 99.5) return 0;
    if (t >= 99.6 && t <= 100.9) return 1;
    if (t >= 101.0) return 2;


    return 0;
}

function ageScore(age) {

    const a = parseInt(age);
    if (isNaN(a)) return 0;
    if (a < 40) return 1;
    if (a <= 65) return 1;
    if (a > 65) return 2;

    return 0;
}

async function fetchPatients() {
  const allPatients = [];
  const failedPages = new Set();
  const totalPages = 10;

  
  for (let page = 1; page <= totalPages; page++) {
    const success = await fetchAndStorePage(page, allPatients);
    if (!success) failedPages.add(page);
  }

  
  if (failedPages.size > 0) {
    console.log(`\nretrying failed pages: ${[...failedPages].join(', ')}`);
    for (const page of failedPages) {
      const success = await fetchAndStorePage(page, allPatients, 8);
      if (!success) {
        console.error(`page ${page} permanently failed after retries.`);
      }
    }
  }

  console.log(`\nfinal patient count: ${allPatients.length}`);
  return allPatients;
}



async function fetchAndStorePage(page, allPatients, maxRetries = 5) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      console.log(`\nfetching page ${page} (attempt ${retries + 1})...`);
      const res = await axios.get(`${BASE_URL}/patients?page=${page}&limit=5`, {
        headers: HEADERS,
      });
      const data = res.data;

      console.log(`Raw api response from page ${page}:`);

      console.dir(data, { depth: null });

      let patients = [];

      if (Array.isArray(data.data)) {
        patients = data.data;
        
      } else if (data.data && typeof data.data === 'object') {
        patients = Object.values(data.data).filter(p => p?.patient_id);
      } else if (Array.isArray(data.patients)) {
        patients = data.patients;
      }

      const validPatients = patients.filter(p => p && p.patient_id);
      if (validPatients.length === 0) {
        throw new Error(`page ${page} contained no valid patient records`);
      }

      allPatients.push(...validPatients);
      console.log(`extracted ${validPatients.length} patient from page ${page}`);
      return true;

    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        const waitTime = 4000 + 1000 * retries;
        console.warn(`rate limited on page ${page}. Waiting ${waitTime / 1000}s...`);
        await new Promise(res => setTimeout(res, waitTime));
      } else if (status === 500 || status === 503 || err.message.includes('no valid')) {
        console.warn(`server/format issue on page ${page}, retrying...`);
        await new Promise(res => setTimeout(res, 2000));
      } else {
        console.error(`unexpected error on page ${page}:`, err.message);
        return false;
      }

      retries++;
    }
  }

  return false;
}

function analyze(patients) {
    patients.forEach(p => {

        const id = p.patient_id;
        const [sys, dia] = parseBloodPressure(p.blood_pressure);
        const t = parseFloat(p.temperature);
        const a = parseInt(p.age);

        const hasIssue =
            sys === null || dia === null || isNaN(t) || isNaN(a);

        if (hasIssue) dataIssues.push(id);

        const total =
            bpScore(sys, dia) +
            tempScore(t) +
            ageScore(a);

        if (total >= 4) highRisk.push(id);
        if (!isNaN(t) && t >= 99.6) feverPatients.push(id);
    });
}

async function submit() {
    const payload = {
        high_risk_patients: highRisk,
        fever_patients: feverPatients,
        data_quality_issues: dataIssues,
    };

    try {
        const res = await axios.post(`${BASE_URL}/submit-assessment`, payload, {
            headers: {
                ...HEADERS,
                'Content-Type': 'application/json',
            },
        });
        console.log('Submission response:', res.data);
    } catch (err) {
        console.error('Submission failed:', err.response?.data || err.message);
    }
}

async function run() {


    const patients = await fetchPatients();
    console.log(`Fetched ${patients.length} patients`);

    analyze(patients);

    console.log('High Risk:', highRisk.length, highRisk);
    console.log('Fever:', feverPatients.length, feverPatients);
    console.log('Issues:', dataIssues.length, dataIssues);

    await submit();
}

run();
