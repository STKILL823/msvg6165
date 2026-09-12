<?php
// register.php

// Подключаем файл с настройками базы данных
require_once 'db.php';

// Проверяем, что форма была отправлена методом POST
if ($_SERVER["REQUEST_METHOD"] == "POST") {
    // Получаем и очищаем данные из формы
    $username = trim($_POST['username']);
    $email = trim($_POST['email']);
    $password = $_POST['password'];

    // Простая валидация
    if (empty($username) || empty($email) || empty($password)) {
        die("Пожалуйста, заполните все поля.");
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        die("Некорректный формат email.");
    }

    // Хешируем пароль. Это критически важно для безопасности!
    // Никогда не храни пароли в открытом виде.
    $hashed_password = password_hash($password, PASSWORD_DEFAULT);

    // Проверяем, не занят ли уже такой username или email
    $check_sql = "SELECT id FROM users WHERE username = ? OR email = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param("ss", $username, $email);
    $check_stmt->execute();
    $check_stmt->store_result();

    if ($check_stmt->num_rows > 0) {
        echo "Пользователь с таким именем или email уже существует.";
    } else {
        // Готовим SQL-запрос для вставки данных
        $sql = "INSERT INTO users (username, email, password) VALUES (?, ?, ?)";
        $stmt = $conn->prepare($sql);
        // Привязываем параметры: "sss" означает три строковых параметра
        $stmt->bind_param("sss", $username, $email, $hashed_password);

        if ($stmt->execute()) {
            echo "Регистрация прошла успешно! Теперь вы можете войти.";
        } else {
            echo "Ошибка при регистрации: " . $stmt->error;
        }
        $stmt->close();
    }
    $check_stmt->close();
    $conn->close();
} else {
    // Если кто-то попытается открыть register.php напрямую, перенаправляем на форму
    header("Location: index.html");
    exit();
}
?>
