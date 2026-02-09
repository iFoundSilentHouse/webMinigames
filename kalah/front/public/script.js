const SERVER_URL = window.APP_CONFIG.SERVER_URL;
        
        // Состояние клиента
        const clientState = {
            gameId: null,
            playerId: null,
            playerName: null,
            playerIndex: null,
            eventSource: null,
            gameState: null,
            isConnected: false,
            stones: {}, // Хранилище DOM-элементов камней
            animationQueue: [],
            isAnimating: false
        };
        
        // Логирование
        function log(message, type = 'info') {
            const logContainer = document.getElementById('logContainer');
            const time = new Date().toLocaleTimeString('ru-RU', { 
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.innerHTML = `
                <span class="log-time">[ ${time}]</span>
                <span class="log-${type}"> ${message}</span>
            `;
            
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
            
            console.log(`[ ${type.toUpperCase()}]  ${message}`);
        }
        
        // Форматирование времени
        function formatTime(timestamp) {
            return new Date(timestamp).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }
        
        // Создание игры
        async function createGame() {
            const playerName = document.getElementById('playerName').value.trim() || 'Игрок';
            clientState.playerName = playerName;
            
            try {
                log('Создание новой игры Калах...', 'info');
                
                const response = await fetch(`${SERVER_URL}/game/create`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({ playerName }) // Добавляем имя игрока
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // Сохраняем ВСЕ данные, которые возвращает сервер
                    clientState.gameId = data.gameId;
                    clientState.playerId = data.playerId || data.playerId; // Если сервер возвращает playerId
                    clientState.playerIndex = data.playerIndex || 0;
                    clientState.gameState = data.game;
                    
                    log(`✅ Игра Калах создана! ID: ${data.gameId}`, 'success');
                    log(`👤 Вы - создатель игры (Игрок 1)`, 'info');
                    
                    // НЕ вызываем joinGame! Создатель уже в игре
                    // Вместо этого сразу подключаемся через SSE
                    connectSSE();
                    showGameInfo();
                    initializeBoard();
                    updateGameDisplay();
                    
                    // Показываем пригласительную ссылку
                    showInviteLink();
                    
                } else {
                    log(`❌ Ошибка: ${data.error || data.message}`, 'error');
                }
                
            } catch (error) {
                log(`❌ Ошибка сети: ${error.message}`, 'error');
            }
        }

        // Подключение к игре
        async function joinGame(playerName = null) {
            // Если вызывается из createGame, не выполняем
            if (clientState.playerId && clientState.gameState) {
                return; // Уже подключены
            }
            
            const gameIdInput = document.getElementById('gameId').value.trim();
            
            if (gameIdInput) {
                clientState.gameId = gameIdInput;
            }
            
            if (!clientState.gameId) {
                log('❌ Введите ID игры или создайте новую', 'error');
                return;
            }
            
            if (!playerName) {
                playerName = document.getElementById('playerName').value.trim() || 'Игрок';
            }
            clientState.playerName = playerName;
            
            try {
                log(`Присоединение к игре ${clientState.gameId}...`, 'info');
                
                const response = await fetch(`${SERVER_URL}/game/${clientState.gameId}/join`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({ playerName })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    clientState.playerId = data.playerId;
                    clientState.playerIndex = data.playerIndex;
                    clientState.gameState = data.game;
                    
                    log(`✅ Успешно! Вы - ${data.playerIndex === 0 ? 'Игрок 1 (низ)' : 'Игрок 2 (верх)'}`, 'success');
                    
                    showGameInfo();
                    connectSSE();
                    initializeBoard();
                    updateGameDisplay();
                    
                } else {
                    log(`❌ Ошибка: ${data.error || data.message}`, 'error');
                }
                
            } catch (error) {
                log(`❌ Ошибка сети: ${error.message}`, 'error');
            }
        }

        // Подключение SSE
        function connectSSE() {
            if (clientState.eventSource) {
                clientState.eventSource.close();
            }
            
            const url = `${SERVER_URL}/sse/${clientState.playerId}/${clientState.gameId}`;
            console.log('🔄 Подключение SSE к:', url);
            log(`Подключение SSE: ${url}`, 'info');
            
            clientState.eventSource = new EventSource(url);
            
            clientState.eventSource.onopen = () => {
                clientState.isConnected = true;
                console.log('✅ SSE соединение установлено!');
                log('✅ SSE соединение установлено', 'success');
                
                // Проверяем состояние сразу после подключения
                setTimeout(() => {
                    console.log('Проверка состояния после SSE подключения:', {
                        gameId: clientState.gameId,
                        playerId: clientState.playerId,
                        gameState: clientState.gameState
                    });
                }, 500);
            };
            
            clientState.eventSource.onmessage = (event) => {
                try {
                    let dataStr = event.data;
                    console.log('📨 Получено SSE сообщение:', dataStr.substring(0, 100) + '...');

                    if (dataStr.startsWith('data: ')) {
                        dataStr = dataStr.substring(6);
                    }
                    if (dataStr.trim() === '') return;

                    const data = JSON.parse(dataStr);
                    console.log('📊 Парсинг SSE данных:', data.type);

                    // ────────────────────────────────────────────────
                    // Обработка реванша — вставляем сюда
                    if (data.type === 'rematch_accepted') {
                        log('🔄 Реванш принят! Переключаемся на новую игру...', 'success');

                        // Обновляем идентификатор игры
                        clientState.gameId = data.newGameId;

                        // Обновляем видимое поле (если есть)
                        const gameIdInput = document.getElementById('gameId');
                        if (gameIdInput) gameIdInput.value = data.newGameId;

                        // Закрываем старое соединение
                        if (clientState.eventSource) {
                            clientState.eventSource.close();
                            clientState.eventSource = null;
                        }

                        // Даём серверу небольшое время → подключаемся заново
                        setTimeout(() => {
                            connectSSE();

                            // Даём ещё чуть времени, чтобы новое соединение установилось и пришло game_state
                            setTimeout(() => {
                                showGameInfo();
                                initializeBoard();          // заново рисуем доску
                                updateGameDisplay();
                                log(`Теперь играем в ${clientState.gameId}`, 'info');
                            }, 1200);
                        }, 400);

                        return; // ← важный момент — выходим, чтобы не обрабатывать это сообщение дальше
                    }

                    // ────────────────────────────────────────────────
                    // существующие обработчики (оставляем как есть)
                    if (data.type === 'connected') {
                        console.log('✅ Подтверждение подключения SSE');
                        log('✅ Подтверждение SSE подключения', 'success');
                    }
                    else if (data.type === 'game_state') {
                        console.log('🎮 Получено состояние игры:', {
                            status: data.game?.status,
                            boardLength: data.game?.board?.length
                        });
                        clientState.gameState = data.game;
                        updateGameDisplay();
                    }
                    else if (data.type === 'game_update') {
                        console.log('🔄 Получено обновление игры:', {
                            status: data.game?.status,
                            boardLength: data.game?.board?.length,
                            currentPlayer: data.game?.currentPlayer
                        });
                        clientState.gameState = data.game;
                        updateGameDisplay();
                    }
                    else if (data.type === 'player_joined') {
                        console.log('👤 Игрок присоединился:', data.playerName);
                        if (data.game) {
                            clientState.gameState = data.game;
                            updateGameDisplay();
                        }
                    }
                    else if (data.type === 'ping') {
                        console.log('🏓 Получен ping');
                    }
                    else {
                        console.log('📨 Неизвестный тип SSE:', data.type, data);
                    }

                } catch (error) {
                    console.error('❌ Ошибка парсинга SSE:', error);
                    log(`❌ Ошибка парсинга SSE: ${error.message}`, 'error');
                }
            };
            
            clientState.eventSource.onerror = (error) => {
                console.error('❌ Ошибка SSE соединения:', error);
                log('❌ Ошибка SSE соединения', 'error');
                clientState.isConnected = false;
                
                setTimeout(() => {
                    if (!clientState.isConnected) {
                        console.log('🔄 Попытка переподключения SSE...');
                        log('Попытка переподключения...', 'info');
                        connectSSE();
                    }
                }, 3000);
            };
        }


        // Показываем информацию об игре
        function showGameInfo() {
            const gameInfoDiv = document.getElementById('game-info');
            if (gameInfoDiv && clientState.gameId) {
                gameInfoDiv.innerHTML = `
                    <div>ID игры: <strong>${clientState.gameId}</strong></div>
                    <div>Вы: <strong>${clientState.playerName}</strong> (Игрок ${clientState.playerIndex + 1})</div>
                    <div>Статус: <span id="game-status">${clientState.gameState?.status || 'подключение...'}</span></div>
                `;
            }
        }

        // Показываем ссылку для приглашения
        function showInviteLink() {
            const inviteDiv = document.getElementById('invite-section');
            if (inviteDiv && clientState.gameId) {
                inviteDiv.style.display = 'block';
                const inviteLink = `${window.location.origin}?game=${clientState.gameId}`;
                inviteDiv.innerHTML = `
                    <h4>Пригласите друга:</h4>
                    <p>ID игры: <code>${clientState.gameId}</code></p>
                    <p>Или отправьте ссылку: <a href="${inviteLink}" target="_blank">${inviteLink}</a></p>
                    <button onclick="copyInviteLink()">Скопировать ссылку</button>
                `;
                log('📤 Ссылка для приглашения сгенерирована', 'info');
            }
        }

        function copyInviteLink() {
            const link = `${window.location.origin}?game=${clientState.gameId}`;
            navigator.clipboard.writeText(link).then(() => {
                log('✅ Ссылка скопирована в буфер обмена', 'success');
            });
        }

        // Обновляем обработчик SSE сообщений
        function handleServerEvent(data) {
            switch (data.type) {
                case 'connected':
                    log('✅ Подтверждение SSE подключения', 'success');
                    break;
                    
                case 'game_state':
                    log('📋 Получено начальное состояние игры', 'info');
                    clientState.gameState = data.game;
                    updateGameDisplay();
                    break;
                    
                case 'player_joined':
                    log(`👤 ${data.playerName || 'Игрок'} присоединился!`, 'info');
                    addMessageToChat(`${data.playerName || 'Игрок'} присоединился к игре`, 'system');
                    if (data.game) {
                        clientState.gameState = data.game;
                        updateGameDisplay();
                    }
                    break;
                    
                case 'ping':
                    // Игнорируем ping-сообщения
                    break;
                    
                default:
                    log(`📨 Получено сообщение типа: ${data.type}`, 'info');
            }
        }
        
        // Обработка обновления с анимацией
        function handleAnimatedUpdate(data) {
            // Сначала обновляем состояние игры
            clientState.gameState = data.game;
            
            // Если есть анимация, добавляем её в очередь
            if (data.animation && data.animation.length > 0) {
                clientState.animationQueue = data.animation;
                startAnimation();
            } else {
                updateGameDisplay();
            }
        }
        
        // Запуск анимации
function startAnimation() {
    if (clientState.isAnimating || clientState.animationQueue.length === 0) {
        clientState.isAnimating = false;
        updateGameDisplay();   // обновляем статус + индикатор хода
        updateChat();
        updateBoardDisplay();  // ← только в конце всей цепочки!
        return;
    }

    clientState.isAnimating = true;
    const step = clientState.animationQueue.shift();

    switch (step.type) {
        case 'pickup':     animatePickup(step); break;
        case 'move':       animateStoneMove(step); break;
        case 'capture':    animateCapture(step); break;
        case 'extra_turn': animateExtraTurn(step); break;
    }
}
        
        // Анимация взятия камней
        function animatePickup(step) {
    const pit = document.getElementById(`pit_${step.from}`);
    if (pit) {
        pit.classList.add('active');
        setTimeout(() => {
            pit.classList.remove('active');
            startAnimation();        // сразу переходим к полёту камней
        }, 400);
    } else {
        startAnimation();
    }
}

        
        // Анимация перемещения камня
function animateStoneMove(step) {
    const fromPit = document.getElementById(`pit_${step.from}`);
    const toPit   = document.getElementById(`pit_${step.to}`);

    if (!fromPit || !toPit) {
        startAnimation();
        return;
    }

    const fromRect = fromPit.getBoundingClientRect();
    const toRect   = toPit.getBoundingClientRect();

    const startX = fromRect.left + fromRect.width / 2;
    const startY = fromRect.top  + fromRect.height / 2;
    const endX   = toRect.left   + toRect.width / 2;
    const endY   = toRect.top    + toRect.height / 2;

    // Создаём новый камень для полёта
    const stone = document.createElement('div');
    stone.className = `stone flying  ${step.from < 7 ? 'player1' : 'player2'}`;
    stone.style.position = 'fixed';
    stone.style.left =  ` ${startX}px `;
    stone.style.top  =  ` ${startY}px `;
    stone.style.transform = 'translate(-50%, -50%) scale(1.25)';
    stone.style.zIndex = '9999';

    document.getElementById('flying-stones-container').appendChild(stone);

    // Задержка между камнями
    const delay = step.stoneIndex * 80;

    setTimeout(() => {
        stone.style.transition = 'all 650ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        stone.style.left =  ` ${endX}px `;
        stone.style.top  =  ` ${endY}px `;
        stone.style.transform = 'translate(-50%, -50%) scale(1) rotate(360deg)';

        // Отскок при приземлении
        setTimeout(() => {
            stone.style.transition = 'all 180ms ease-out';
            stone.style.transform = 'translate(-50%, -50%) scale(1.15)';
        }, 650);

        setTimeout(() => {
            stone.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 830);

        // Удаляем камень и запускаем следующий
        setTimeout(() => {
            stone.remove();
            startAnimation();
        }, 950);
    }, delay);
}
        // Анимация захвата камней
function animateCapture(step) {
    const [pit1, pit2] = step.from;
    const toStoreIndex = step.to;

    const store = document.getElementById(toStoreIndex === 6 ? 'storePlayer1' : 'storePlayer2');
    if (!store) {
        startAnimation();
        return;
    }

    const storeRect = store.getBoundingClientRect();
    const endX = storeRect.left + storeRect.width / 2;
    const endY = storeRect.top  + storeRect.height / 2;

    const pits = [document.getElementById( `pit_${pit1}`), document.getElementById( `pit_${pit2}`)];

    for (let i = 0; i < step.stones; i++) {
        const stone = document.createElement('div');
        stone.className =  `stone flying  ${pit1 < 7 ? 'player1' : 'player2'} `;
        document.getElementById('flying-stones-container').appendChild(stone);

        const startPit = pits[i % 2];
        const startRect = startPit.getBoundingClientRect();

        stone.style.left =  ` ${startRect.left + startRect.width / 2}px `;
        stone.style.top  =  ` ${startRect.top + startRect.height / 2}px `;
        stone.style.transform = 'translate(-50%, -50%) scale(1.2)';

        setTimeout(() => {
            stone.style.transition = 'all 850ms cubic-bezier(0.4, 0, 0.2, 1)';
            stone.style.left =  ` ${endX + (Math.random() * 60 - 30)}px `;
            stone.style.top  =  ` ${endY + (Math.random() * 50 - 25)}px `;
            stone.style.transform = 'translate(-50%, -50%) scale(1) rotate(720deg)';
        }, i * 70 + 300);

        setTimeout(() => {
            stone.remove();
            if (i === step.stones - 1) startAnimation();
        }, i * 70 + 1200);
    }

    // Подсветка лунок
    pits.forEach(p => p?.classList.add('active'));
    setTimeout(() => pits.forEach(p => p?.classList.remove('active')), 1400);
}
        // Анимация дополнительного хода
        function animateExtraTurn(step) {
            const playerIndicator = document.getElementById('currentPlayerIndicator');
            if (playerIndicator) {
                playerIndicator.classList.add('animate-pulse');
                setTimeout(() => {
                    playerIndicator.classList.remove('animate-pulse');
                    updateGameDisplay();
                    setTimeout(() => startAnimation(), 300);
                }, 1000);
            } else {
                setTimeout(() => startAnimation(), 300);
            }
            setTimeout(() => {
        playerIndicator.classList.remove('animate-pulse');
        updateGameDisplay();

        // ← Вот это добавляем
        clientState.isAnimating = false;
        startAnimation();
    }, 1000);
        }
        
        // Создание камней для анимации
        function createAnimationStones(fromPitIndex, stoneCount) {
            const fromPit = document.getElementById( `pit_${fromPitIndex}`);
            if (!fromPit) return;
            
            const pitRect = fromPit.getBoundingClientRect();
            
            for (let i = 0; i < Math.min(stoneCount, 10); i++) {
                const stone = document.createElement('div');
                stone.id =  `stone_ ${fromPitIndex}_ ${i} `;
                stone.className =  `stone  ${fromPitIndex < 7 ? 'player1' : 'player2'} `;
                
                // Случайная позиция внутри лунки
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.random() * 30;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                
                stone.style.left =  `calc(50% +  ${x}px) `;
                stone.style.top =  `calc(50% +  ${y}px) `;
                stone.style.transform =  `translate(-50%, -50%) `;
                
                document.body.appendChild(stone);
                clientState.stones[ `stone_ ${fromPitIndex}_ ${i} `] = stone;
            }
        }
        
        // Обработка реванша
        function handleRematchAccepted(data) {
            log( `🔄 Реванш принят! Новая игра:  ${data.newGameId} `, 'success');
            
            clientState.gameId = data.newGameId;
            document.getElementById('gameId').value = data.newGameId;
            
            setTimeout(() => {
                connectSSE();
                log('Переподключение к новой игре...', 'info');
            }, 1000);
        }
        
        // Обработка обычных событий
        function handleServerEvent(data) {
            switch(data.type) {
                case 'connected':
                    log( `Сервер:  ${data.message} `, 'info');
                    break;
                case 'game_state':
                    clientState.gameState = data.game;
                    updateGameDisplay();
                    break;
                case 'ping':
                    break;
            }
        }
        
        // Ход в Калахе
        async function makeMove(pitIndex) {
            if (!clientState.gameId || !clientState.playerId) {
                log('Сначала присоединитесь к игре', 'error');
                return;
            }
            
            if (clientState.gameState.status !== 'playing') {
                log('Игра еще не началась или уже завершена', 'warning');
                return;
            }
            
            if (clientState.gameState.currentPlayer !== clientState.playerIndex) {
                log( `Сейчас не ваш ход `, 'warning');
                return;
            }
            
            try {
                log( `Ход из лунки  ${pitIndex}... `, 'info');
                const response = await fetch(`${SERVER_URL}/game/${clientState.gameId.trim()}/move`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId,
                        pitIndex: pitIndex
                    })
                });
                
                const data = await response.json();
                
                if (!data.success) {
                    log( `❌ Ошибка:  ${data.error} `, 'error');
                }
                
            } catch (error) {
                log( `❌ Ошибка отправки хода:  ${error.message} `, 'error');
            }
        }
        
        async function surrender() {
            if (!confirm('Вы уверены, что хотите сдаться? Противник победит, но вы сможете предложить реванш.')) {
                return;
            }
        
            if (!clientState.gameId || !clientState.playerId) {
                log('Сначала присоединитесь к игре', 'error');
                return;
            }
        
            try {
                log('🕊️ Отправка сдачи...', 'info');
                const response = await fetch( `${SERVER_URL}/game/${clientState.gameId}/surrender`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ playerId: clientState.playerId })
                });
        
                const data = await response.json();
        
                if (data.success) {
                    log('✅ Вы сдались! Игра завершена, можно предложить реванш.', 'success');
                } else {
                    log( `❌ Ошибка:  ${data.error} `, 'error');
                }
            } catch (error) {
                log( `❌ Ошибка сети:  ${error.message} `, 'error');
            }
        }
        
        // Предложение реванша
        async function offerRematch() {
            if (!clientState.gameId || !clientState.playerId) return;
            
            try {
                log('Предложение реванша...', 'info');
                const response = await fetch( `${SERVER_URL}/game/${clientState.gameId}/rematch`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    if (data.newGameId) {
                        log( `✅ Реванш начался! Новая игра:  ${data.newGameId} `, 'success');
                    } else {
                        log('✅ Предложение реванша отправлено', 'success');
                    }
                } else {
                    log( `❌ Ошибка:  ${data.error} `, 'error');
                }
                
            } catch (error) {
                log( `❌ Ошибка:  ${error.message} `, 'error');
            }
        }
        
        // Принятие реванша
        async function acceptRematch() {
            await offerRematch();
        }
        
        // Показать информацию об игроке
        function showGameInfo() {
            const playerInfo = document.getElementById('playerInfo');
            playerInfo.classList.remove('hidden');
            
            document.getElementById('infoName').textContent = clientState.playerName;
            document.getElementById('infoSide').textContent = clientState.playerIndex === 0 ? 'Игрок 1 (нижний ряд)' : 'Игрок 2 (верхний ряд)';
            document.getElementById('infoGameId').textContent = clientState.gameId;
            document.getElementById('infoPlayerId').textContent = clientState.playerId;
            
            document.getElementById('gameId').value = clientState.gameId;
        }
        
        // Инициализация доски
        function initializeBoard() {
            // Очищаем доску
            document.getElementById('pitsPlayer1').innerHTML = '';
            document.getElementById('pitsPlayer2').innerHTML = '';
            
            // Создаем лунки игрока 1 (0-5)
            for (let i = 0; i < 6; i++) {
                createPitElement(i, 'player1');
            }
            
            // Создаем лунки игрока 2 (7-12), но отображаем в обратном порядке
            for (let i = 7; i <= 12; i++) {
                createPitElement(i, 'player2');
            }
        }
        
        // Создание элемента лунки
        function createPitElement(index, player) {
            const pit = document.createElement('div');
            pit.className = 'kalah-pit';
            pit.id =  `pit_${index}`;
            pit.dataset.index = index;
            
            const displayNumber = player === 'player1' ? index : 12 - (index - 7);
            
            pit.innerHTML =  `
                <div class="pit-label"> ${displayNumber}</div>
                <div class="pit-count" id="count_${index}">0</div>
                <div class="stones-container" id="stones_${index}"></div>
             `;
            
            // Назначаем обработчик клика
            pit.addEventListener('click', () => {
                if (!pit.classList.contains('disabled')) {
                    makeMove(index);
                }
            });
            
            // Добавляем в соответствующий ряд
            if (player === 'player1') {
                document.getElementById('pitsPlayer1').appendChild(pit);
            } else {
                document.getElementById('pitsPlayer2').appendChild(pit);
            }
            
            return pit;
        }
        
        // Обновление отображения игры
        function updateGameDisplay() {
            const gameStatus = document.getElementById('gameStatus');
            const kalahBoard = document.getElementById('kalahBoard');
            const rematchPanel = document.getElementById('rematchPanel');
            const currentPlayerIndicator = document.getElementById('currentPlayerIndicator');
            
            const surrenderPanel = document.getElementById('surrenderPanel');
            if (clientState.gameState.status === 'playing') {
                surrenderPanel.classList.remove('hidden');
            } else {
                surrenderPanel.classList.add('hidden');
            }
            
            if (clientState.gameState) {
                kalahBoard.style.display = 'flex';
                
                // Обновляем статус
                const statusText = getStatusText(clientState.gameState);
                gameStatus.textContent = statusText;
                gameStatus.className =  `game-status status- ${clientState.gameState.status} `;
                
                // Обновляем индикатор текущего игрока
                if (clientState.gameState.status === 'playing') {
                    currentPlayerIndicator.classList.remove('hidden');
                    const isPlayer1 = clientState.gameState.currentPlayer === 0;
                    currentPlayerIndicator.className =  `current-player-indicator  ${isPlayer1 ? 'player1' : 'player2'} `;
                    document.getElementById('playerIndicatorDot').className =  `player-indicator-dot  ${isPlayer1 ? 'player1' : 'player2'} `;
                    document.getElementById('currentPlayerText').textContent =  `Сейчас ходит:  ${isPlayer1 ? 'Игрок 1' : 'Игрок 2'} `;
                } else {
                    currentPlayerIndicator.classList.add('hidden');
                }
                
                // Обновляем доску
                updateBoardDisplay();
                
                // Обновляем чат
                updateChat();
                
                // Показываем/скрываем панель реванша
                if (clientState.gameState.status === 'finished') {
                    rematchPanel.classList.remove('hidden');
                    
                    const rematchMessage = document.getElementById('rematchMessage');
                    const btnOfferRematch = document.getElementById('btnOfferRematch');
                    const btnAcceptRematch = document.getElementById('btnAcceptRematch');
                    
                    if (clientState.gameState.rematchOfferedBy) {
                        if (clientState.gameState.rematchOfferedBy === clientState.playerId) {
                            rematchMessage.textContent = 'Вы предложили реванш. Ожидайте ответа...';
                            btnOfferRematch.classList.add('hidden');
                            btnAcceptRematch.classList.add('hidden');
                        } else {
                            rematchMessage.textContent = 'Противник предлагает реванш!';
                            btnOfferRematch.classList.add('hidden');
                            btnAcceptRematch.classList.remove('hidden');
                        }
                    } else {
                        rematchMessage.textContent = 'Хотите сыграть реванш?';
                        btnOfferRematch.classList.remove('hidden');
                        btnAcceptRematch.classList.add('hidden');
                    }
                } else {
                    rematchPanel.classList.add('hidden');
                }
                
                // Завершаем анимацию
                clientState.isAnimating = false;
            }
        }
        
        // Обновление доски
        function updateBoardDisplay() {
            if (!clientState.gameState || !clientState.gameState.board) return;
            
            const board = clientState.gameState.board;
            
            // Обновляем калахи
            document.querySelector('#storePlayer1 .store-count').textContent = board[6];
            document.querySelector('#storePlayer2 .store-count').textContent = board[13];
            
            // Обновляем все лунки
            for (let i = 0; i < 14; i++) {
                if (i === 6 || i === 13) continue; // Пропускаем калахи
                
                const pit = document.getElementById( `pit_${i}`);
                const countElement = document.getElementById( `count_${i}`);
                const stonesContainer = document.getElementById( `stones_${i}`);
                
                if (pit && countElement && stonesContainer) {
                    const count = board[i];
                    countElement.textContent = count;
                    
                    // Очищаем и создаем камни
                    stonesContainer.innerHTML = '';
                    
                    // Создаем визуальные камни
                    createStonesInPit(i, count, stonesContainer);
                    
                    // Обновляем состояние лунки
                    updatePitState(pit, i, count);
                }
            }
        }
        
        // Создание камней в лунке
function createStonesInPit(pitIndex, count, container) {
    container.innerHTML = ''; // очищаем

    if (count === 0) return;

    const isStore = pitIndex === 6 || pitIndex === 13;
    const maxVisible = isStore ? 35 : 16;
    const toShow = Math.min(count, maxVisible);

    const centerX = container.clientWidth / 2;
    const centerY = container.clientHeight / 2;
    const baseRadius = isStore ? 48 : 26;

    for (let i = 0; i < toShow; i++) {
        const stone = document.createElement('div');
        stone.className =  `stone  ${pitIndex < 7 ? 'player1' : 'player2'} `;

        // Золотой угол для красивой спирали
        const angle = i * 137.508; // ≈ 360° / золотое сечение
        const radius = baseRadius * (1 - Math.floor(i / 10) * 0.15); // слои уменьшаются

        const x = centerX + Math.cos(angle * Math.PI / 180) * radius;
        const y = centerY + Math.sin(angle * Math.PI / 180) * radius * 0.85;

        stone.style.left =  ` ${x}px `;
        stone.style.top  =  ` ${y}px `;

        // Лёгкое вращение и размер
        const scale = 0.9 + Math.random() * 0.2;
        stone.style.transform =  `translate(-50%, -50%) scale( ${scale}) rotate(${Math.random() * 30 - 15}deg) `;

        container.appendChild(stone);
    }

    // +N если много
    if (count > maxVisible) {
        const extra = document.createElement('div');
        extra.style.position = 'absolute';
        extra.style.bottom = isStore ? '16px' : '10px';
        extra.style.right = '14px';
        extra.style.background = 'rgba(0,0,0,0.75)';
        extra.style.color = 'white';
        extra.style.padding = '4px 8px';
        extra.style.borderRadius = '12px';
        extra.style.fontSize = '12px';
        extra.style.fontWeight = 'bold';
        extra.textContent =  `+ ${count - maxVisible} `;
        container.appendChild(extra);
    }
}
        
        // Обновление состояния лунки
        function updatePitState(pit, index, count) {
            const isPlayer1Pit = index < 6 || index === 6;
            const isPlayer2Pit = (index >= 7 && index <= 12) || index === 13;
            
            // Сбрасываем классы
            pit.classList.remove('active', 'disabled');
            
            if (clientState.gameState.status === 'playing') {
                const isCurrentPlayer = clientState.gameState.currentPlayer === clientState.playerIndex;
                const isPlayersTurn = (clientState.playerIndex === 0 && isPlayer1Pit) || 
                                     (clientState.playerIndex === 1 && isPlayer2Pit);
                
                // Проверяем, может ли игрок ходить из этой лунки
                if (isCurrentPlayer && isPlayersTurn && count > 0 && 
                    ((clientState.playerIndex === 0 && index >= 0 && index <= 5) ||
                     (clientState.playerIndex === 1 && index >= 7 && index <= 12))) {
                    
                    pit.classList.add('active');
                    pit.style.cursor = 'pointer';
                } else {
                    pit.classList.add('disabled');
                    pit.style.cursor = 'not-allowed';
                }
            } else {
                pit.classList.add('disabled');
                pit.style.cursor = 'default';
            }
        }
        
        // Получение текста статуса
        function getStatusText(state) {
            switch(state.status) {
                case 'waiting':
                    return '⏳ Ожидание второго игрока...';
                case 'playing':
                    return  `🎲 Игра идёт. Ход:  ${state.currentPlayer === 0 ? 'Игрок 1' : 'Игрок 2'} `;
                case 'finished':
                    if (state.winner === 'draw') {
                        return  `🤝 Ничья!  ${state.scores.player1}: ${state.scores.player2} `;
                    } else {
                        const winnerName = state.winner === 'player1' ? 'Игрок 1' : 'Игрок 2';
                        return  `🏆 Победил  ${winnerName} ( ${state.scores.player1}: ${state.scores.player2}) `;
                    }
                default:
                    return state.status;
            }
        }
        
        // Обновление чата
        function updateChat() {
            if (!clientState.gameState || !clientState.gameState.messages) return;
            
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            
            clientState.gameState.messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                
                if (msg.type === 'system') {
                    messageDiv.className = 'message message-system';
                } else if (msg.type === 'move') {
                    messageDiv.className = 'message message-move';
                } else if (msg.player) {
                    messageDiv.className =  `message message- ${msg.playerIndex === 0 ? 'player1' : 'player2'} `;
                } else {
                    messageDiv.className = 'message';
                }
                
                let senderName = '';
                if (msg.type === 'system') {
                    senderName = 'Система';
                } else if (msg.player) {
                    senderName = msg.player;
                }
                
                messageDiv.innerHTML =  `
                    <div class="message-header">
                        <span class="message-sender"> ${senderName}</span>
                        <span class="message-time"> ${formatTime(msg.timestamp)}</span>
                    </div>
                    <div class="message-text"> ${msg.text}</div>
                 `;
                
                chatMessages.appendChild(messageDiv);
            });
            
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        // Глобальные функции
        window.createGame = createGame;
        window.joinGame = joinGame;
        window.offerRematch = offerRematch;
        window.acceptRematch = acceptRematch;
        window.surrender = surrender;
        
        // Инициализация
        document.addEventListener('DOMContentLoaded', () => {
            log('🎮 Игра Калах инициализирована. Готов к работе!', 'success');
            log( `⚡ Сервер:  ${SERVER_URL} `, 'info');
            document.getElementById('playerName').focus();
        });