require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const expressLayouts = require('express-ejs-layouts');
const { Octokit } = require("@octokit/rest");
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('[Arsyilla] MongoDB Connected'))
    .catch(err => console.error('[Arsyilla] MongoDB Error:', err));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    apiKey: { type: String, unique: true }
});

const FolderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    folderName: String,
    repoName: String,
    shareCode: { type: String, unique: true },
    dbPath: String
});

const User = mongoose.model('User', UserSchema);
const Folder = mongoose.model('Folder', FolderSchema);
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = process.env.GITHUB_OWNER;

const ArsyillaGitHub = {
    async createRepo(repoName) {
        try {
            await octokit.repos.createForAuthenticatedUser({
                name: repoName,
                auto_init: false
            });
        } catch (error) {
            if (error.status !== 422) throw error;
        }
    },
    async uploadFile(repoName, fileName, content) {
        let sha;
        try {
            const { data } = await octokit.repos.getContent({
                owner: GITHUB_OWNER, repo: repoName, path: fileName
            });
            sha = data.sha;
        } catch (e) { sha = undefined; }

        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER,
            repo: repoName,
            path: fileName,
            message: `Arsyilla System Update`,
            content: Buffer.from(content).toString("base64"),
            sha: sha
        });
    }
};

const getTimestamp = () => {
    const date = new Date();
    const options = { 
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        timeZone: 'Asia/Jakarta'
    };
    const formatter = new Intl.DateTimeFormat('id-ID', options).format(date);
    return formatter.replace(/[\/]/g, '-').replace(', ', '-').replace(/\s/g, '-');
};

const authenticateKey = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: "API Key diperlukan." });
    const user = await User.findOne({ apiKey });
    if (!user) return res.status(401).json({ error: "API Key tidak valid." });
    req.user = user;
    next();
};

app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login'));

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const apiKey = `BC_${Math.floor(10000000 + Math.random() * 90000000)}`;
        const newUser = new User({ username, password, apiKey });
        await newUser.save();
        res.status(201).json({ message: "Registrasi Berhasil", apiKey });
    } catch (error) {
        res.status(400).json({ error: "Username sudah digunakan." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) return res.status(401).json({ error: "Username atau Password salah." });
        res.json({ message: "Login Berhasil", apiKey: user.apiKey });
    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/db/save', authenticateKey, async (req, res) => {
    try {
        const { dbName, fileName, content } = req.body;
        const repoDB = "Arsyilla-Database-Public";

        let folder = await Folder.findOne({ userId: req.user._id, folderName: dbName, repoName: repoDB });
        
        if (!folder) {
            const ts = getTimestamp();
            const dbPath = `${ts}/${dbName}`;
            const shareCode = crypto.randomBytes(6).toString('hex');

            await ArsyillaGitHub.createRepo(repoDB);
            folder = new Folder({
                userId: req.user._id,
                folderName: dbName,
                repoName: repoDB,
                shareCode,
                dbPath
            });
            await folder.save();
        }

        const targetFile = `${folder.dbPath}/${fileName}`;
        await ArsyillaGitHub.uploadFile(repoDB, targetFile, content);

        res.json({
            success: true,
            message: "Database Updated",
            url: `/db/${folder.shareCode}/${fileName}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/db/:shareCode/:fileName', async (req, res) => {
    const { shareCode, fileName } = req.params;
    const folder = await Folder.findOne({ shareCode });
    if (!folder) return res.status(404).send("DB tidak ditemukan.");
    
    res.redirect(`https://raw.githubusercontent.com/${GITHUB_OWNER}/${folder.repoName}/main/${folder.dbPath}/${fileName}`);
});

app.post('/api/folder', authenticateKey, async (req, res) => {
    try {
        const { folderName } = req.body;
        const slugRepo = folderName.replace(/\s+/g, '-').toLowerCase();
        const shareCode = crypto.randomBytes(4).toString('hex');

        await ArsyillaGitHub.createRepo(slugRepo);
        const newFolder = new Folder({ userId: req.user._id, folderName, repoName: slugRepo, shareCode, dbPath: '' });
        await newFolder.save();

        res.json({ message: "Repo Backup Berhasil Dibuat", shareCode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/my-folders', authenticateKey, async (req, res) => {
    try {
        const folders = await Folder.find({ userId: req.user._id });
        res.json({ success: true, folders });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/backup/upload', authenticateKey, async (req, res) => {
    try {
        const { folderName, fileName, content } = req.body;
        const folder = await Folder.findOne({ userId: req.user._id, folderName });
        if (!folder) return res.status(404).json({ error: "Repo tidak ditemukan." });

        await ArsyillaGitHub.uploadFile(folder.repoName, fileName, content);
        res.json({ success: true, url: `/s/${folder.shareCode}/${fileName}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/s/:shareCode/:fileName', async (req, res) => {
    const { shareCode, fileName } = req.params;
    const folder = await Folder.findOne({ shareCode });
    if (!folder) return res.status(404).send("Link tidak valid.");
    res.redirect(`https://raw.githubusercontent.com/${GITHUB_OWNER}/${folder.repoName}/main/${fileName}`);
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[Arsyilla] Local server running on port ${PORT}`);
    });
}

module.exports = app;
