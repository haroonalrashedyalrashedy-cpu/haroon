package com.alrashidi.exchange.model;

public class Rate {
    private String fromCurrency;
    private String toCurrency;
    private double rate;
    
    public Rate(String fromCurrency, String toCurrency, double rate) {
        this.fromCurrency = fromCurrency;
        this.toCurrency = toCurrency;
        this.rate = rate;
    }
    
    public String getFromCurrency() { return fromCurrency; }
    public String getToCurrency() { return toCurrency; }
    public double getRate() { return rate; }
}
