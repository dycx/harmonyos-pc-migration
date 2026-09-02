package demo.backend;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * DemoBackend —— 模板自带的零依赖后端（开箱即用，验证前后端链路）
 *
 * 说明：
 * - 使用 JDK 内置 com.sun.net.httpserver（jdk.httpserver 模块），无需任何三方依赖
 * - 编译：javac --release 17 -d out demo/backend/DemoBackend.java && jar 打包（见 build-backend.sh）
 * - 正式项目：替换为 SpringBoot 工程（见 backend-springboot/ 骨架 + README）
 *
 * 接口：
 * - GET  /api/hello        → {"message":"Hello from HarmonyOS PC backend"}
 * - GET  /api/ping         → pong（前端/探测用）
 * - POST /api/echo         → 原样返回请求体（测试 POST）
 */
public class DemoBackend {

    public static void main(String[] args) throws IOException {
        int port = 8080;
        // 支持命令行覆盖端口：java -jar demo-backend.jar 8081
        if (args.length > 0) {
            try {
                port = Integer.parseInt(args[0]);
            } catch (NumberFormatException ignored) {
            }
        }

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        final int bindPort = port;
        server.createContext("/api/hello", exchange -> {
            String body = "{\"message\":\"Hello from HarmonyOS PC backend\",\"port\":" + bindPort + "}";
            respond(exchange, 200, "application/json", body);
        });
        server.createContext("/api/ping", exchange ->
                respond(exchange, 200, "text/plain", "pong"));
        server.createContext("/api/echo", exchange -> {
            if ("POST".equals(exchange.getRequestMethod())) {
                String req = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                respond(exchange, 200, "application/json",
                        "{\"echo\":" + escapeJson(req) + "}");
            } else {
                respond(exchange, 405, "text/plain", "method not allowed");
            }
        });

        server.setExecutor(null);
        server.start();
        System.out.println("[DemoBackend] listening on 127.0.0.1:" + port);
    }

    private static void respond(HttpExchange exchange, int code, String contentType, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType + "; charset=utf-8");
        // 允许前端（重定向域名）跨域访问
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static String escapeJson(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default: sb.append(c);
            }
        }
        return sb.toString();
    }
}
