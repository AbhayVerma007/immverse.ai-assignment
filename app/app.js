require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('node:path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const UI_STAGES = [
    { name: 'Git Push to Develop', icon: '📤', keywords: [], virtual: true },
    { name: 'Checkout Project', icon: '📥', keywords: ['checkout source', 'checkout'] },
    { name: 'SonarQube Analysis', icon: '🔍', keywords: ['sonarqube'] },
    { name: 'Build Docker Image', icon: '🐳', keywords: ['docker build'] },
    { name: 'Deploy to ECR', icon: '☁️', keywords: ['push to ecr', 'ecr registry', 'ecr'] },
    { name: 'Deploy to Server', icon: '🚀', keywords: ['deploy to private', 'deploy to ec2'] },
    { name: 'Slack Alert', icon: '🔔', keywords: ['slack'], onFailureOnly: true },
];

const jenkinsAuth = () => ({
    username: process.env.JENKINS_USER,
    password: process.env.JENKINS_TOKEN,
});

function normalizeStatus(raw) {
    if (!raw) return 'PENDING';
    const value = String(raw).toUpperCase();
    if (value === 'SUCCESS') return 'SUCCESS';
    if (value === 'FAILED' || value === 'FAILURE' || value === 'ABORTED') return 'FAILED';
    if (value === 'IN_PROGRESS' || value === 'RUNNING') return 'IN_PROGRESS';
    if (value === 'PAUSED' || value === 'SKIPPED' || value === 'NOT_EXECUTED') return 'PENDING';
    return 'PENDING';
}

function matchStageName(name, keywords) {
    const lower = name.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
}

function findJenkinsStage(rawStages, keywords) {
    return rawStages.find((stage) => matchStageName(stage.name, keywords));
}

function parseStagesFromLogs(logText, buildResult, isBuilding) {
    const stageOpenRegex = /\[Pipeline\]\s*\{\s*\(([^)]+)\)/g;
    const seen = [];
    let match;
    while ((match = stageOpenRegex.exec(logText)) !== null) {
        seen.push(match[1].trim());
    }

    const failedStageMatch = logText.match(/Stage ["']([^"']+)["'] failed/i);
    const failedStageName = failedStageMatch ? failedStageMatch[1] : null;
    const slackTriggered = /slackSend|Slack notification|Pipeline Failed:/i.test(logText);

    return UI_STAGES.map((uiStage) => {
        if (uiStage.virtual) {
            return { ...uiStage, status: seen.length > 0 || isBuilding || buildResult ? 'SUCCESS' : 'PENDING' };
        }

        if (uiStage.onFailureOnly) {
            if (buildResult === 'FAILURE') {
                return {
                    ...uiStage,
                    name: 'Slack Alert Sent',
                    icon: '🚨',
                    status: slackTriggered ? 'SUCCESS' : 'IN_PROGRESS',
                };
            }
            return { ...uiStage, status: 'SKIPPED', detail: 'Only runs on failure' };
        }

        const jenkinsStage = seen.find((name) => matchStageName(name, uiStage.keywords));
        if (!jenkinsStage) {
            return { ...uiStage, status: isBuilding ? 'PENDING' : 'PENDING' };
        }

        const lastSeen = seen[seen.length - 1];
        const stageIndex = seen.lastIndexOf(jenkinsStage);
        const isLastSeen = lastSeen === jenkinsStage;

        if (buildResult === 'SUCCESS') {
            return { ...uiStage, status: 'SUCCESS', jenkinsStage };
        }

        if (buildResult === 'FAILURE') {
            if (failedStageName && matchStageName(failedStageName, uiStage.keywords)) {
                return { ...uiStage, status: 'FAILED', jenkinsStage };
            }
            if (failedStageName) {
                const failedIndex = seen.findIndex((name) => name === failedStageName);
                if (failedIndex >= 0 && stageIndex < failedIndex) {
                    return { ...uiStage, status: 'SUCCESS', jenkinsStage };
                }
                if (failedIndex >= 0 && stageIndex > failedIndex) {
                    return { ...uiStage, status: 'PENDING', jenkinsStage };
                }
            }
            if (isLastSeen) return { ...uiStage, status: 'FAILED', jenkinsStage };
            if (stageIndex < seen.length - 1) return { ...uiStage, status: 'SUCCESS', jenkinsStage };
            return { ...uiStage, status: 'FAILED', jenkinsStage };
        }

        if (isBuilding) {
            if (isLastSeen) return { ...uiStage, status: 'IN_PROGRESS', jenkinsStage };
            if (stageIndex < seen.length - 1) return { ...uiStage, status: 'SUCCESS', jenkinsStage };
            return { ...uiStage, status: 'PENDING', jenkinsStage };
        }

        return { ...uiStage, status: 'PENDING', jenkinsStage };
    });
}

function buildStagesFromWfapi(rawStages, buildResult, isBuilding) {
    return UI_STAGES.map((uiStage) => {
        if (uiStage.virtual) {
            return { ...uiStage, status: 'SUCCESS' };
        }

        if (uiStage.onFailureOnly) {
            if (buildResult === 'FAILURE') {
                return { ...uiStage, name: 'Slack Alert Sent', icon: '🚨', status: 'SUCCESS' };
            }
            return { ...uiStage, status: 'SKIPPED', detail: 'Only runs on failure' };
        }

        const found = findJenkinsStage(rawStages, uiStage.keywords);
        if (found) {
            return { ...uiStage, status: normalizeStatus(found.status), jenkinsStage: found.name };
        }

        if (isBuilding) {
            const completedCount = rawStages.filter((s) => normalizeStatus(s.status) === 'SUCCESS').length;
            const uiIndex = UI_STAGES.findIndex((s) => s.name === uiStage.name);
            const pipelineIndex = UI_STAGES.filter((s) => !s.virtual && !s.onFailureOnly).findIndex((s) => s.name === uiStage.name);
            if (pipelineIndex === completedCount) return { ...uiStage, status: 'IN_PROGRESS' };
            if (pipelineIndex < completedCount) return { ...uiStage, status: 'SUCCESS' };
        }

        if (buildResult === 'SUCCESS') return { ...uiStage, status: 'SUCCESS' };
        return { ...uiStage, status: 'PENDING' };
    });
}

app.get('/api/pipeline-status', async (req, res) => {
    const url = process.env.JENKINS_URL;
    const job = process.env.JOB_NAME;

    try {
        const statusResponse = await axios.get(`${url}/job/${job}/lastBuild/api/json`, {
            auth: jenkinsAuth(),
            timeout: 8000,
        });

        const buildResult = statusResponse.data.result;
        const isBuilding = statusResponse.data.building;
        const buildNumber = statusResponse.data.number;
        const buildUrl = statusResponse.data.url;

        let stages;
        let source = 'logs';

        try {
            const wfResponse = await axios.get(`${url}/job/${job}/lastBuild/wfapi/describe`, {
                auth: jenkinsAuth(),
                timeout: 8000,
            });

            const rawStages = wfResponse.data.stages || [];
            if (rawStages.length > 0) {
                stages = buildStagesFromWfapi(rawStages, buildResult, isBuilding);
                source = 'wfapi';
            }
        } catch {
            // wfapi often unavailable; fall back to console log parsing
        }

        if (!stages) {
            const logResponse = await axios.get(`${url}/job/${job}/lastBuild/consoleText`, {
                auth: jenkinsAuth(),
                timeout: 8000,
            });
            stages = parseStagesFromLogs(logResponse.data, buildResult, isBuilding);
        }

        res.json({
            buildNumber,
            buildUrl,
            result: buildResult || (isBuilding ? 'IN_PROGRESS' : null),
            building: isBuilding,
            source,
            stages: stages.map(({ name, status, icon, detail }) => ({ name, status, icon, detail })),
        });
    } catch (error) {
        console.error('Status fetch error:', error.message);
        res.status(200).json({
            buildNumber: null,
            result: 'UNKNOWN',
            building: false,
            source: 'error',
            error: error.message,
            stages: UI_STAGES.map((stage) => ({
                name: stage.name,
                icon: stage.icon,
                status: stage.virtual ? 'SUCCESS' : 'PENDING',
                detail: stage.onFailureOnly ? 'Only runs on failure' : undefined,
            })),
        });
    }
});

app.get('/api/pipeline-logs', async (req, res) => {
    const url = process.env.JENKINS_URL;
    const job = process.env.JOB_NAME;

    if (!url || !job) {
        res.send('> Jenkins credentials not configured.');
        return;
    }

    try {
        const response = await axios.get(`${url}/job/${job}/lastBuild/consoleText`, {
            auth: jenkinsAuth(),
            timeout: 8000,
        });
        res.send(response.data);
    } catch (error) {
        res.send(`> Waiting for log stream connection...\n> ${error.message}`);
    }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(3000, () => console.log('Dashboard operational on port 3000'));
