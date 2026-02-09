import express from 'express';

const router = express.Router();

// Главная страница с игрой - рендерим EJS шаблон
router.get('/', (req, res) => {
    // Передаем переменные из .env в шаблон
    res.render('index', {
        env: {
            SERVER_URL: process.env.SERVER_URL || 'http://localhost:3004',
        },
    });
});

export default router;