package com.yourcompany.harmony.controller;

import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 示例控制器（模板骨架，与 demo 后端的接口对齐，便于链路验证）
 *
 * GET  /api/ping   → pong
 * GET  /api/hello  → JSON 问候
 * POST /api/echo   → 回显
 */
@RestController
@RequestMapping("/api")
public class DemoController {

    @GetMapping("/ping")
    public String ping() {
        return "pong";
    }

    @GetMapping("/hello")
    public Map<String, Object> hello() {
        return Map.of("message", "Hello from HarmonyOS PC backend (SpringBoot)",
                "source", "springboot-template");
    }

    @PostMapping("/echo")
    public Map<String, String> echo(@RequestBody String body) {
        return Map.of("echo", body == null ? "" : body);
    }
}
