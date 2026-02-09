import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
const router = express.Router();

// Создаем __dirname для ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Главная страница с игрой (обновленный HTML с анимациями)
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'front', 'public', 'index.html'));
});

export default router;