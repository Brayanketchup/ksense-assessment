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
    let page = 1;
    const allPatients = [];

    while (true) {
        let retries = 0;
        while (retries < MAX_RETRIES) {
            try {
                console.log(`fetching page ${page}...`);
                const res = await axios.get(`${BASE_URL}/patients?page=${page}&limit=5`, {
                    headers: HEADERS,
                });
                const data = res.data;
                if (!data.data || !Array.isArray(data.data)) {
                    console.warn(`malformed response on page ${page}. Skipping...`);
                    break; 
                }

                allPatients.push(...data.data);

                if (!data.pagination.hasNext) return allPatients;
                page++;

                await new Promise(res => setTimeout(res, 1500));
                break;
            } catch (err) {
                const status = err.response?.status;
                if (status === 429) {
                    retries++;
                    console.warn(`rate limited on page ${page}. Waiting 4s (retry ${retries})...`);
                    await new Promise(res => setTimeout(res, 4000));
                } else if (status === 500 || status === 503) {
                    retries++;
                    console.warn(`server error on page ${page}. Retrying in 2s (retry ${retries})...`);
                    await new Promise(res => setTimeout(res, 2000));
                } else {
                    console.error('unexpected error:', err.message);
                    return allPatients;
                }
            }
        }

        if (retries === MAX_RETRIES) {
            console.error(`failed after ${MAX_RETRIES} retries on page ${page}. stopping.`);
            return allPatients;
        }
    }
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
