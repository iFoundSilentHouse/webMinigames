// Инициализация доски
export function initializeKalahBoard() {
    const board = Array(14).fill(6);
    board[6] = 0;  // Калах игрока 1
    board[13] = 0; // Калах игрока 2
    return board;
}

// Проверка возможности хода
export function canPlayerMove(board, playerIndex) {
    const start = playerIndex === 0 ? 0 : 7;
    const end = playerIndex === 0 ? 5 : 12;

    for (let i = start; i <= end; i++) {
        if (board[i] > 0) return true;
    }
    return false;
}

// Логика хода с генерацией данных для анимации
export function makeKalahMove(board, pitIndex, playerIndex) {
    console.log(`[KALAH] Ход из лунки ${pitIndex} игроком ${playerIndex}`);

    const newBoard = [...board];
    let stones = newBoard[pitIndex];
    newBoard[pitIndex] = 0;

    let currentIndex = pitIndex;
    const opponentKalah = playerIndex === 0 ? 13 : 6;
    const playerKalah = playerIndex === 0 ? 6 : 13;

    // Данные для анимации
    const animationSteps = [];
    animationSteps.push({
        type: 'pickup',
        from: pitIndex,
        stones: stones
    });

    // Распределяем камни
    const distribution = [];
    while (stones > 0) {
        currentIndex = (currentIndex + 1) % 14;

        // Пропускаем калах противника
        if (currentIndex === opponentKalah) {
            continue;
        }

        distribution.push(currentIndex);
        stones--;
    }

    // Добавляем шаги распределения для анимации
    let delay = 0;
    distribution.forEach((targetIndex, i) => {
        animationSteps.push({
            type: 'move',
            from: pitIndex,
            to: targetIndex,
            stoneIndex: i,
            delay: delay
        });
        delay += 200; // Задержка между перемещениями камней
    });

    // Применяем распределение
    distribution.forEach(index => {
        newBoard[index]++;
    });

    const lastIndex = distribution[distribution.length - 1];

    // Проверяем захват
    let captureAnimation = null;
    if (lastIndex >= (playerIndex === 0 ? 0 : 7) &&
        lastIndex <= (playerIndex === 0 ? 5 : 12) &&
        newBoard[lastIndex] === 1) {

        const oppositeIndex = 12 - lastIndex;
        if (newBoard[oppositeIndex] > 0) {
            console.log(`[KALAH] Захват! Лунка ${lastIndex} -> ${oppositeIndex}`);

            captureAnimation = {
                type: 'capture',
                from: [lastIndex, oppositeIndex],
                to: playerKalah,
                stones: newBoard[lastIndex] + newBoard[oppositeIndex],
                delay: delay + 300
            };

            animationSteps.push(captureAnimation);

            newBoard[playerKalah] += newBoard[lastIndex] + newBoard[oppositeIndex];
            newBoard[lastIndex] = 0;
            newBoard[oppositeIndex] = 0;
        }
    }

    // Дополнительный ход если попал в свой калах
    const extraTurn = lastIndex === playerKalah;
    if (extraTurn && captureAnimation) {
        animationSteps.push({
            type: 'extra_turn',
            player: playerIndex,
            delay: captureAnimation.delay + 500
        });
    } else if (extraTurn) {
        animationSteps.push({
            type: 'extra_turn',
            player: playerIndex,
            delay: delay + 300
        });
    }

    return {
        board: newBoard,
        extraTurn,
        animation: animationSteps
    };
}

// Проверка конца игры
export function checkGameEnd(board) {
    const player1HasMoves = canPlayerMove(board, 0);
    const player2HasMoves = canPlayerMove(board, 1);

    if (!player1HasMoves || !player2HasMoves) {
        const newBoard = [...board];
        let player1Score = newBoard[6];
        let player2Score = newBoard[13];

        // Собираем камни игрока 1
        for (let i = 0; i <= 5; i++) {
            player1Score += newBoard[i];
            newBoard[i] = 0;
        }

        // Собираем камни игрока 2
        for (let i = 7; i <= 12; i++) {
            player2Score += newBoard[i];
            newBoard[i] = 0;
        }

        newBoard[6] = player1Score;
        newBoard[13] = player2Score;

        let winner = null;
        if (player1Score > player2Score) {
            winner = 'player1';
        } else if (player2Score > player1Score) {
            winner = 'player2';
        } else {
            winner = 'draw';
        }

        return {
            gameOver: true,
            board: newBoard,
            winner,
            scores: { player1: player1Score, player2: player2Score }
        };
    }

    return { gameOver: false };
}