export const games = new Map();
export const connections = new Map();

// Функция отправки SSE (вынесена из sseRoutes)
export function sendSSE(res, data) {
    try {
        if (res && !res.destroyed && !res.finished && !res.writableEnded) {
            const jsonData = JSON.stringify(data);
            res.write(`data: ${jsonData}\n\n`);
            console.log(`[SSE SEND] → ${data.type || 'unknown'} отправлено`);
            return true;
        } else {
            console.log(`[SSE SEND] НЕЛЬЗЯ ОТПРАВИТЬ — res invalid (destroyed=${res?.destroyed}, finished=${res?.finished}, ended=${res?.writableEnded})`);
            return false;
        }
    } catch (error) {
        console.error('[SEND SSE] Ошибка:', error.message);
        return false;
    }
}

// Рассылка состояния игры
export function broadcastGameState(gameId, sourcePlayerId = null, animationData = null) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`[BROADCAST ERROR] Игра ${gameId} не найдена в Map`);
        return;
    }

    console.log(`[BROADCAST] Начинаем рассылку для игры ${gameId}`);
    console.log(`[BROADCAST] Статус игры: ${game.state.status}`);
    console.log(`[BROADCAST] Игроков: ${game.players.length}`);
    
    // Формируем данные для отправки
    const updateData = {
        type: 'game_update',
        game: game.state,
        timestamp: Date.now(),
        sourcePlayerId,
        animation: animationData
    };

    let sentCount = 0;
    let totalPlayers = game.players.length;
    
    game.players.forEach((player, index) => {
        const connection = connections.get(player.id);
        
        if (connection && connection.res) {
            console.log(`[BROADCAST ${index}] Игрок ${player.id} (${player.name}): проверка соединения...`);
            
            if (!connection.res.destroyed && !connection.res.finished && !connection.res.writableEnded) {
                console.log(`[BROADCAST ${index}] Отправка данных игроку ${player.name}...`);
                const sent = sendSSE(connection.res, updateData);
                
                if (sent) {
                    sentCount++;
                    console.log(`[BROADCAST ${index}] ✓ Успешно отправлено игроку ${player.name}`);
                } else {
                    console.log(`[BROADCAST ${index}] ✗ Не удалось отправить игроку ${player.name}`);
                }
            } else {
                console.log(`[BROADCAST ${index}] ✗ Соединение игрока ${player.name} неактивно`);
            }
        } else {
            console.log(`[BROADCAST ${index}] ✗ Нет SSE соединения для игрока ${player.name} (${player.id})`);
        }
    });
    
    console.log(`[BROADCAST] Результат: отправлено ${sentCount}/${totalPlayers} игрокам`);
    
    // Если не все получили, логируем детали
    if (sentCount < totalPlayers) {
        console.log(`[BROADCAST WARNING] Не все игроки получили обновление!`);
        game.players.forEach((player, index) => {
            const hasConnection = connections.has(player.id);
            console.log(`[BROADCAST DEBUG] Игрок ${index+1}: ${player.name}, соединение: ${hasConnection ? 'есть' : 'нет'}`);
        });
    }
}