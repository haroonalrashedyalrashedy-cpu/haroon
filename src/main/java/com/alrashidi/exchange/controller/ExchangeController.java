package com.alrashidi.exchange.controller;

import com.alrashidi.exchange.model.Rate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.List;

@RestController
public class ExchangeController {
    
    @GetMapping("/api/rates")
    public List<Rate> getRates() {
        return List.of(
            new Rate("USD", "SAR", 3.75),
            new Rate("EUR", "SAR", 4.10),
            new Rate("GBP", "SAR", 4.75)
        );
    }
    
    @GetMapping("/health")
    public String health() {
        return "Al-Rashidi Exchange API is running!";
    }
}
