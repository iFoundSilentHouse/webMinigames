import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import frontendRouter from './front/index.js';
import gameRouter from './back/routes/gameLogic.js';
import gameStateRouter from './back/routes/gameState.js';
import statsRouter from './back/routes/stats.js';

const app = express();
app.use(cors());
app.use(express.json());

// Создаем __dirname для ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'front', 'public')));
app.use('/', frontendRouter);

// back
app.use('/', gameRouter);
app.use('/', gameStateRouter);
app.use('/', statsRouter);

// Запуск сервера
const PORT = 3004;
app.listen(PORT, () => {
    console.log('🎮 ===========================================');
    console.log('🎮  Сервер Калах с анимациями запущен!');
    console.log('🎮 ===========================================');
  console.log('📡  API работает на порту 3004');
  console.log('');
  console.log('✨  Особенности:');
  console.log('   • 🎨 Современный красивый интерфейс');
  console.log('   • ✨ Плавные анимации перемещения камней');
  console.log('   • 🔄 Полная поддержка реванша');
  console.log('   • 💬 Встроенный чат с подсветкой игроков');
  console.log('   • 📊 Детальные логи всех событий');
  console.log('');
  console.log('🎯  Как играть:');
  console.log('   1. Откройте адрес сайта в двух вкладках');
  console.log('   2. Создайте игру в первой вкладке');
  console.log('   3. Присоединитесь по ID во второй вкладке');
  console.log('   4. Кликайте по активным лункам для хода');
  console.log('   5. Наслаждайтесь анимациями!');
  console.log('');
  console.log('🔄  Анимации включают:');
  console.log('   • Подсветку выбранной лунки');
  console.log('   • Плавное перемещение камней');
  console.log('   • Эффект захвата камней');
  console.log('   • Индикатор дополнительного хода');
  console.log('============================================');
});

