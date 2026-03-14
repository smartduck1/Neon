<?php
// hostinger_sync.php
// Syncs Render Node.js server data to Hostinger

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$secret = "neon_ultimate_secret_key";
$dataFile = 'server_data.json';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (isset($_GET['secret']) && $_GET['secret'] === $secret) {
        if (file_exists($dataFile)) {
            header('Content-Type: application/json');
            echo file_get_contents($dataFile);
        } else {
            echo json_encode(["leaderboard" => ["singleplayer" => [], "multiplayer" => []], "usernames" => []]);
        }
    } else {
        http_response_code(403);
        echo json_encode(["error" => "Unauthorized"]);
    }
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (isset($input['secret']) && $input['secret'] === $secret) {
        if (isset($input['data'])) {
            file_put_contents($dataFile, json_encode($input['data'], JSON_PRETTY_PRINT));
            echo json_encode(["success" => true]);
        } else {
            http_response_code(400);
            echo json_encode(["error" => "No data provided"]);
        }
    } else {
        http_response_code(403);
        echo json_encode(["error" => "Unauthorized"]);
    }
}
?>
