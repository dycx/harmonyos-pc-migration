package com.yourcompany.harmony;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 鸿蒙 PC 后端入口（模板骨架）
 *
 * 说明：
 * - 端口/绑定见 application.yml（默认 8080）
 * - 构建：mvn clean package -DskipTests → target/app.jar
 */
@SpringBootApplication
public class HarmonyBackendApplication {

    public static void main(String[] args) {
        SpringApplication.run(HarmonyBackendApplication.class, args);
    }
}
