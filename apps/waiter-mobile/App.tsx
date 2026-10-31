import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, type HealthStatus } from './src/lib/api';

export default function App() {
  const [status, setStatus] = useState<HealthStatus | 'checking'>('checking');

  useEffect(() => {
    const controller = new AbortController();
    api.health
      .check(controller.signal)
      .then((result) => setStatus(result.status))
      .catch(() => setStatus('error'));
    return () => controller.abort();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>FoodStack Waiter</Text>
      <Text>API: {status}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '600' },
});
