<?php
// db.php

$servername = "localhost"; // Обычно localhost, но уточни на хостинге
$username = "твой_логин_от_базы"; // Например, whg122514_x3ue_user
$password = "твой_пароль_от_базы";
$dbname = "whg122514_x3ue"; // Имя твоей базы данных из URL

// Создаем подключение с помощью mysqli
$conn = new mysqli($servername, $username, $password, $dbname);

// Проверяем соединение
if ($conn->connect_error) {
    die("Ошибка подключения: " . $conn->connect_error);
}

// Устанавливаем кодировку
$conn->set_charset("utf8mb4");
?>
